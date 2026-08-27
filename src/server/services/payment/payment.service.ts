import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '@/lib/db';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/http';
import { audit } from '@/lib/auth';
import { getTenantContext } from '../../repositories/tenant.repo';
import { scheduleAppointmentNotifications } from '../notification.service';
import type { PaymentProvider } from './provider';
import { ManualProvider } from './providers/manual.provider';
import { MercadoPagoProvider } from './providers/mercadopago.provider';

let providerInstance: PaymentProvider | null = null;

export function getProvider(): PaymentProvider {
  if (providerInstance) return providerInstance;
  providerInstance =
    env.payment.provider === 'mercadopago' ? new MercadoPagoProvider() : new ManualProvider();
  return providerInstance;
}

export type CheckoutMode = 'deposit' | 'full';

/**
 * Cria (ou reaproveita) a cobranca de uma reserva.
 * A chave de idempotencia amarra grupo + tipo: clicar duas vezes em "pagar"
 * nao gera duas cobrancas.
 */
export async function createCheckout(input: {
  tenantId: string;
  bookingGroupId: string;
  mode: CheckoutMode;
  method: 'pix' | 'card';
  ip?: string;
}): Promise<{
  paymentId: string;
  amount: number;
  status: string;
  checkoutUrl: string | null;
  qrCode: string | null;
  qrCodeBase64: string | null;
  expiresAt: string | null;
}> {
  const { tenant, settings } = await getTenantContext(input.tenantId);

  if (input.mode === 'deposit' && !settings.allow_deposit) {
    throw ApiError.badRequest('Esta empresa nao aceita pagamento de sinal');
  }
  if (input.mode === 'full' && !settings.allow_full_payment) {
    throw ApiError.badRequest('Esta empresa nao aceita pagamento integral online');
  }
  if (!settings.payment_methods.includes(input.method)) {
    throw ApiError.badRequest('Forma de pagamento nao aceita por esta empresa');
  }

  const group = await queryOne<{
    total: number;
    paid: number;
    client_name: string;
    client_phone: string;
    client_id: string;
    first_appointment: string;
    services: string;
    active_count: number;
  }>(
    `SELECT COALESCE(sum(a.total_amount), 0)::float8 AS total,
            COALESCE(sum(a.paid_amount), 0)::float8 AS paid,
            min(c.name) AS client_name, min(c.phone) AS client_phone, min(c.id::text) AS client_id,
            min(a.id::text) AS first_appointment,
            string_agg(DISTINCT (SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                                   FROM appointment_services s WHERE s.appointment_id = a.id), ' | ') AS services,
            count(*) FILTER (WHERE a.status IN ('pending','confirmed'))::int AS active_count
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = $1 AND a.booking_group_id = $2`,
    [input.tenantId, input.bookingGroupId]
  );

  if (!group || !group.active_count) throw ApiError.notFound('Reserva nao encontrada ou expirada');

  const percent = input.mode === 'deposit' ? Number(settings.deposit_percent) : 100;
  const amount = Math.round(((group.total * percent) / 100) * 100) / 100;
  if (amount <= 0) throw ApiError.badRequest('Valor invalido para cobranca');

  const idempotencyKey = `${input.bookingGroupId}:${input.mode}:${input.method}`;
  const kind = input.mode === 'deposit' ? 'deposit' : 'full';

  const existing = await queryOne<{ id: string; status: string; checkout_url: string | null; qr_code: string | null; qr_code_base64: string | null; expires_at: Date | null; amount: number }>(
    `SELECT id, status, checkout_url, qr_code, qr_code_base64, expires_at, amount::float8 AS amount
       FROM payments WHERE tenant_id = $1 AND idempotency_key = $2`,
    [input.tenantId, idempotencyKey]
  );

  if (existing && ['pending', 'processing', 'paid'].includes(existing.status)) {
    const stillValid = !existing.expires_at || new Date(existing.expires_at) > new Date();
    if (stillValid) {
      return {
        paymentId: existing.id,
        amount: existing.amount,
        status: existing.status,
        checkoutUrl: existing.checkout_url,
        qrCode: existing.qr_code,
        qrCodeBase64: existing.qr_code_base64,
        expiresAt: existing.expires_at?.toISOString() ?? null,
      };
    }
  }

  const provider = getProvider();

  const created = await queryOne<{ id: string }>(
    `INSERT INTO payments (tenant_id, booking_group_id, appointment_id, client_id, amount, kind,
                           method, status, provider, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6::payment_kind,$7::payment_method,'pending',$8,$9)
     ON CONFLICT (tenant_id, idempotency_key)
     DO UPDATE SET status = 'pending', amount = EXCLUDED.amount, method = EXCLUDED.method, updated_at = now()
     RETURNING id`,
    [
      input.tenantId,
      input.bookingGroupId,
      group.first_appointment,
      group.client_id,
      amount,
      kind,
      input.method,
      provider.name,
      idempotencyKey,
    ]
  );
  const paymentId = created!.id;

  const charge = await provider.createCharge({
    paymentId,
    amount,
    description: `${tenant.name} - ${group.services ?? 'Servicos'}`,
    method: input.method,
    payer: { name: group.client_name, phone: group.client_phone },
    returnUrl: `${env.appUrl}/agendar/${tenant.slug}/retorno?payment=${paymentId}`,
    webhookUrl: `${env.appUrl}/api/v1/payments/webhook/${provider.name}`,
    expiresInMinutes: settings.hold_expiration_minutes,
  });

  await query(
    `UPDATE payments
        SET provider_payment_id = $2, checkout_url = $3, qr_code = $4, qr_code_base64 = $5,
            expires_at = $6, status = $7::payment_status, metadata = $8::jsonb
      WHERE id = $1`,
    [
      paymentId,
      charge.providerPaymentId,
      charge.checkoutUrl,
      charge.qrCode,
      charge.qrCodeBase64,
      charge.expiresAt,
      charge.status,
      JSON.stringify({ mode: input.mode, percent }),
    ]
  );

  // Gateway ja aprovou na criacao (raro, mas acontece no Pix): confirma agora.
  if (charge.status === 'paid') {
    await settlePayment(paymentId, amount);
  }

  await audit({
    tenantId: input.tenantId,
    action: 'payment.checkout',
    entity: 'payment',
    entityId: paymentId,
    actor: 'client',
    after: { amount, mode: input.mode, method: input.method },
    ip: input.ip,
  });

  return {
    paymentId,
    amount,
    status: charge.status,
    checkoutUrl: charge.checkoutUrl,
    qrCode: charge.qrCode,
    qrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt?.toISOString() ?? null,
  };
}

/** Distribui o valor pago entre os agendamentos do grupo, proporcional ao total de cada um. */
async function applyToGroup(
  tx: PoolClient,
  tenantId: string,
  bookingGroupId: string,
  amount: number
): Promise<string[]> {
  const rows = await tx.query<{ id: string; total_amount: number }>(
    `SELECT id, total_amount::float8 AS total_amount
       FROM appointments
      WHERE tenant_id = $1 AND booking_group_id = $2 AND status IN ('pending','confirmed')
      ORDER BY starts_at
      FOR UPDATE`,
    [tenantId, bookingGroupId]
  );
  if (!rows.rowCount) return [];

  const groupTotal = rows.rows.reduce((s, r) => s + Number(r.total_amount), 0) || 1;
  const ids: string[] = [];
  let distributed = 0;

  for (const [index, appt] of rows.rows.entries()) {
    const isLast = index === rows.rows.length - 1;
    const share = isLast
      ? Math.round((amount - distributed) * 100) / 100
      : Math.round(((Number(appt.total_amount) / groupTotal) * amount) * 100) / 100;
    distributed += share;

    await tx.query(
      `UPDATE appointments
          SET paid_amount = LEAST(total_amount, paid_amount + $3),
              status = CASE WHEN status = 'pending' THEN 'confirmed'::appointment_status ELSE status END,
              hold_expires_at = NULL,
              payment_status = CASE
                WHEN paid_amount + $3 >= total_amount THEN 'paid'::payment_status
                ELSE 'partially_paid'::payment_status END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, appt.id, share]
    );
    ids.push(appt.id);
  }
  return ids;
}

/**
 * Confirma um pagamento e o agendamento correspondente.
 * Idempotente: se ja estava pago, nao soma de novo.
 */
export async function settlePayment(paymentId: string, amount?: number): Promise<void> {
  const confirmedAppointments = await transaction(async (tx) => {
    const payment = await tx.query<{
      id: string;
      tenant_id: string;
      booking_group_id: string | null;
      amount: number;
      status: string;
    }>(
      `SELECT id, tenant_id, booking_group_id, amount::float8 AS amount, status
         FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId]
    );
    if (!payment.rowCount) throw ApiError.notFound('Pagamento nao encontrado');
    const row = payment.rows[0];
    if (row.status === 'paid') return []; // ja processado

    await tx.query(
      `UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1`,
      [paymentId]
    );

    if (!row.booking_group_id) return [];
    return applyToGroup(tx, row.tenant_id, row.booking_group_id, amount ?? row.amount);
  });

  for (const appointmentId of confirmedAppointments) {
    const tenant = await queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM appointments WHERE id = $1',
      [appointmentId]
    );
    if (tenant) {
      await scheduleAppointmentNotifications(tenant.tenant_id, appointmentId).catch((err) =>
        console.error('[notificacao] falha pos-pagamento:', err)
      );
    }
  }
}

export async function markPaymentStatus(paymentId: string, status: string): Promise<void> {
  await query(`UPDATE payments SET status = $2::payment_status WHERE id = $1`, [paymentId, status]);
}

/**
 * Webhook. Grava o evento primeiro: se o gateway reenviar o mesmo evento, o
 * UNIQUE barra e nada e processado duas vezes.
 */
export async function handleWebhook(
  providerName: string,
  req: Request,
  rawBody: string
): Promise<{ processed: boolean; reason?: string }> {
  const provider = getProvider();
  if (provider.name !== providerName) {
    throw ApiError.badRequest('Provider desconhecido');
  }

  const event = await provider.parseWebhook(req, rawBody);
  if (!event) return { processed: false, reason: 'evento ignorado' };

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO payment_webhook_events (provider, external_id, event_type, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [providerName, event.externalId, event.eventType, JSON.stringify(event.raw ?? {})]
  );
  if (!inserted) return { processed: false, reason: 'evento duplicado' };

  try {
    const payment = event.paymentId
      ? await queryOne<{ id: string; amount: number }>(
          `SELECT id, amount::float8 AS amount FROM payments WHERE id = $1`,
          [event.paymentId]
        )
      : await queryOne<{ id: string; amount: number }>(
          `SELECT id, amount::float8 AS amount FROM payments
            WHERE provider = $1 AND provider_payment_id = $2`,
          [providerName, event.providerPaymentId]
        );

    if (!payment) {
      await query(
        `UPDATE payment_webhook_events SET processed_at = now(), error = $2 WHERE id = $1`,
        [inserted.id, 'pagamento nao encontrado']
      );
      return { processed: false, reason: 'pagamento nao encontrado' };
    }

    if (event.status === 'paid') {
      await settlePayment(payment.id, event.amount ?? payment.amount);
    } else {
      await markPaymentStatus(payment.id, event.status);
    }

    await query(`UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1`, [inserted.id]);
    return { processed: true };
  } catch (err) {
    await query(
      `UPDATE payment_webhook_events SET processed_at = now(), error = $2 WHERE id = $1`,
      [inserted.id, err instanceof Error ? err.message : 'erro']
    );
    throw err;
  }
}

/** Pagamento registrado na loja (dinheiro, maquininha, Pix na hora). */
export async function registerManualPayment(input: {
  tenantId: string;
  appointmentId: string;
  amount: number;
  method: 'pix' | 'card' | 'cash' | 'transfer' | 'other';
  userId: string;
  ip?: string;
}): Promise<void> {
  const appt = await queryOne<{ booking_group_id: string; client_id: string; total_amount: number; paid_amount: number }>(
    `SELECT booking_group_id, client_id, total_amount::float8 AS total_amount, paid_amount::float8 AS paid_amount
       FROM appointments WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.appointmentId]
  );
  if (!appt) throw ApiError.notFound('Agendamento nao encontrado');
  if (input.amount <= 0) throw ApiError.badRequest('Valor invalido');

  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO payments (tenant_id, booking_group_id, appointment_id, client_id, amount, kind,
                             method, status, provider, idempotency_key, paid_at, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'onsite',$6::payment_method,'paid','onsite',$7, now(), $8)`,
      [
        input.tenantId,
        appt.booking_group_id,
        input.appointmentId,
        appt.client_id,
        input.amount,
        input.method,
        `onsite:${input.appointmentId}:${Date.now()}`,
        input.userId,
      ]
    );

    await tx.query(
      `UPDATE appointments
          SET paid_amount = LEAST(total_amount, paid_amount + $3),
              payment_status = CASE
                WHEN paid_amount + $3 >= total_amount THEN 'paid'::payment_status
                ELSE 'partially_paid'::payment_status END,
              status = CASE WHEN status = 'pending' THEN 'confirmed'::appointment_status ELSE status END,
              hold_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.appointmentId, input.amount]
    );
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'payment.manual',
    entity: 'appointment',
    entityId: input.appointmentId,
    after: { amount: input.amount, method: input.method },
    ip: input.ip,
  });
}

export async function getPaymentPublic(paymentId: string) {
  const payment = await queryOne(
    `SELECT p.id, p.amount::float8 AS amount, p.status, p.method, p.kind,
            p.checkout_url, p.qr_code, p.qr_code_base64, p.expires_at, p.booking_group_id,
            (SELECT a.manage_token FROM appointments a
              WHERE a.booking_group_id = p.booking_group_id AND a.manage_token IS NOT NULL LIMIT 1) AS manage_token
       FROM payments p WHERE p.id = $1`,
    [paymentId]
  );
  if (!payment) throw ApiError.notFound('Pagamento nao encontrado');
  return payment;
}
