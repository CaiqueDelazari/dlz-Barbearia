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

/**
 * Gateway de UMA loja.
 *
 * Nao existe mais provider global: um deploy atende varias barbearias e as
 * credenciais do gateway sao de quem contratou a cobranca online. Escolher por
 * `PAYMENT_PROVIDER` fazia toda loja com `online_payment_required` ligado cobrar
 * para a conta dessa unica dona -- Pix saindo certo para o destino errado, sem
 * erro nenhum no caminho.
 *
 * `payment_provider` vem de `business_settings` e nasce 'manual'. So quem tem a
 * coluna preenchida ganha gateway de verdade, e a coluna nao e' editavel pelo
 * painel (ver a migration 007).
 *
 * A checagem do ambiente continua valendo: se a loja pede um gateway que este
 * deploy nao tem configurado, cai em manual em vez de tentar cobrar sem
 * credencial e falhar na frente do cliente.
 */
export function getProviderForSettings(settings: { payment_provider: string }): PaymentProvider {
  if (settings.payment_provider === 'mercadopago' && env.payment.provider === 'mercadopago') {
    return new MercadoPagoProvider();
  }
  return new ManualProvider();
}

/** Provider pelo nome, para o webhook -- que chega pelo gateway, nao pela loja. */
export function getProviderByName(name: string): PaymentProvider | null {
  if (name === 'mercadopago' && env.payment.provider === 'mercadopago') {
    return new MercadoPagoProvider();
  }
  if (name === 'manual') return new ManualProvider();
  return null;
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

  const provider = getProviderForSettings(settings);

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
 * Devolve o dinheiro de um pagamento, no todo ou em parte.
 *
 * **Registro, nao transferencia.** Isto anota que a devolucao aconteceu e
 * desfaz o efeito dela no sistema; quem devolve de fato e' o dono, no Pix ou
 * na maquininha. Nao existe estorno automatico porque nao existe gateway
 * ligado -- e mesmo quando existir, estorno de cartao passa pelo adquirente e
 * demora dias, entao o registro continua sendo o passo de dentro.
 *
 * O que precisa acontecer junto, ou o sistema fica mentindo:
 *
 * - `payments.refunded_amount` sobe, e o status vira 'refunded' so quando a
 *   devolucao alcanca o valor pago. Devolveu metade, o pagamento continua
 *   'paid' -- porque metade dele continua sendo dinheiro que entrou.
 * - `appointments.paid_amount` desce na mesma proporcao com que o pagamento
 *   subiu, e `payment_status` volta para 'partially_paid' ou 'pending'. Sem
 *   isso o horario seguiria marcado como pago e ninguem cobraria de novo.
 *
 * O rateio repete o do `applyToGroup`, inclusive o ajuste na ultima parcela,
 * para que devolver tudo devolva exatamente tudo: dividir por proporcao deixa
 * centavo sobrando, e centavo sobrando num campo de dinheiro vira uma cobranca
 * fantasma de R$ 0,01 que ninguem consegue quitar.
 */
export async function refundPayment(input: {
  tenantId: string;
  paymentId: string;
  amount?: number;
  reason?: string;
  userId?: string | null;
  ip?: string;
}): Promise<{ refundedNow: number; refundedTotal: number; status: string }> {
  const resultado = await transaction(async (tx) => {
    const encontrado = await tx.query<{
      id: string;
      tenant_id: string;
      booking_group_id: string | null;
      amount: number;
      refunded_amount: number;
      status: string;
    }>(
      `SELECT id, tenant_id, booking_group_id,
              amount::float8 AS amount, refunded_amount::float8 AS refunded_amount, status
         FROM payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [input.paymentId, input.tenantId]
    );
    if (!encontrado.rowCount) throw ApiError.notFound('Pagamento nao encontrado');
    const pagamento = encontrado.rows[0];

    // Nao se devolve o que nunca entrou. Um pagamento pendente ou falho se
    // cancela; chamar isso de estorno faria o relatorio contar uma saida de
    // dinheiro que nao houve.
    if (pagamento.status !== 'paid' && pagamento.status !== 'refunded') {
      throw ApiError.conflict(
        `Pagamento ${pagamento.status}: so da para estornar o que foi pago.`,
        'payment_not_paid'
      );
    }

    const jaDevolvido = Number(pagamento.refunded_amount);
    const disponivel = Math.round((Number(pagamento.amount) - jaDevolvido) * 100) / 100;
    if (disponivel <= 0) throw ApiError.conflict('Este pagamento ja foi estornado por inteiro');

    const pedido = input.amount ?? disponivel;
    const valor = Math.round(pedido * 100) / 100;
    if (valor <= 0) throw ApiError.badRequest('O valor do estorno precisa ser maior que zero');
    if (valor > disponivel) {
      throw ApiError.conflict(
        `Restam ${disponivel.toFixed(2)} para estornar neste pagamento.`,
        'refund_exceeds_paid'
      );
    }

    const totalDevolvido = Math.round((jaDevolvido + valor) * 100) / 100;
    const quitado = totalDevolvido >= Number(pagamento.amount);

    await tx.query(
      `UPDATE payments
          SET refunded_amount = $2,
              refunded_at     = now(),
              refund_reason   = COALESCE($3, refund_reason),
              status          = CASE WHEN $4 THEN 'refunded'::payment_status ELSE status END
        WHERE id = $1`,
      [input.paymentId, totalDevolvido, input.reason ?? null, quitado]
    );

    if (pagamento.booking_group_id) {
      await removeFromGroup(tx, input.tenantId, pagamento.booking_group_id, valor);
    }

    return {
      refundedNow: valor,
      refundedTotal: totalDevolvido,
      status: quitado ? 'refunded' : pagamento.status,
    };
  });

  await audit({
    tenantId: input.tenantId,
    userId: input.userId,
    action: 'payment.refund',
    entity: 'payment',
    entityId: input.paymentId,
    after: {
      valor: resultado.refundedNow,
      totalEstornado: resultado.refundedTotal,
      motivo: input.reason ?? null,
    },
    ip: input.ip,
  });

  return resultado;
}

/** Espelho do `applyToGroup`: tira do grupo o que o estorno devolveu. */
async function removeFromGroup(
  tx: PoolClient,
  tenantId: string,
  bookingGroupId: string,
  amount: number
): Promise<void> {
  const rows = await tx.query<{ id: string; total_amount: number }>(
    `SELECT id, total_amount::float8 AS total_amount
       FROM appointments
      WHERE tenant_id = $1 AND booking_group_id = $2
      ORDER BY starts_at
      FOR UPDATE`,
    [tenantId, bookingGroupId]
  );
  if (!rows.rowCount) return;

  const groupTotal = rows.rows.reduce((s, r) => s + Number(r.total_amount), 0) || 1;
  let distributed = 0;

  for (const [index, appt] of rows.rows.entries()) {
    const isLast = index === rows.rows.length - 1;
    const share = isLast
      ? Math.round((amount - distributed) * 100) / 100
      : Math.round(((Number(appt.total_amount) / groupTotal) * amount) * 100) / 100;
    distributed += share;

    await tx.query(
      `UPDATE appointments
          SET paid_amount = GREATEST(0, paid_amount - $3),
              payment_status = CASE
                WHEN GREATEST(0, paid_amount - $3) <= 0 THEN 'pending'::payment_status
                WHEN GREATEST(0, paid_amount - $3) >= total_amount THEN 'paid'::payment_status
                ELSE 'partially_paid'::payment_status END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, appt.id, share]
    );
  }
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
  const provider = getProviderByName(providerName);
  if (!provider) {
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

/**
 * Status da cobranca para a tela de pagamento (sem sessao).
 *
 * O `manage_token` so sai quando o pagamento esta pago. Ele e a chave que
 * permite ver, remarcar e cancelar o agendamento sem senha - entregar isso
 * junto com o QR code do Pix significaria que basta conhecer o id da cobranca
 * (que anda na URL, e URL vaza em Referer, em print e em historico) para
 * controlar a reserva de outra pessoa sem nunca ter pago nada.
 */
export async function getPaymentPublic(paymentId: string) {
  const payment = await queryOne<Record<string, unknown> & { status: string }>(
    `SELECT p.id, p.amount::float8 AS amount, p.status, p.method, p.kind,
            p.checkout_url, p.qr_code, p.qr_code_base64, p.expires_at, p.booking_group_id,
            CASE WHEN p.status = 'paid' THEN (
              SELECT a.manage_token FROM appointments a
               WHERE a.booking_group_id = p.booking_group_id AND a.manage_token IS NOT NULL LIMIT 1
            ) END AS manage_token
       FROM payments p WHERE p.id = $1`,
    [paymentId]
  );
  if (!payment) throw ApiError.notFound('Pagamento nao encontrado');
  return payment;
}
