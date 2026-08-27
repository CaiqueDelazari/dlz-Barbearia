import { query, queryOne } from '@/lib/db';
import { env } from '@/lib/env';
import { formatDateBR, todayInTz, utcToZoned } from '@/lib/datetime';
import { getTenantContext } from '@/server/repositories/tenant.repo';
import { normalizePhone } from '@/server/repositories/client.repo';
import { getDayAvailability } from '@/server/services/availability.service';
import {
  cancelByClient,
  createBooking,
  getBookingByToken,
  rescheduleAppointment,
} from '@/server/services/appointment.service';

/**
 * Ferramentas da IA.
 *
 * Regra inegociavel: a IA NAO escreve no banco. Toda ferramenta aqui chama a
 * mesma camada de servico que a API usa, entao trava de concorrencia,
 * antecedencia minima, bloqueios e politica de cancelamento valem igual.
 * Se a IA inventar um horario, o servico recusa.
 */

export type ToolContext = { tenantId: string; phone: string };

const money = (v: number) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

export const TOOL_DEFINITIONS = [
  {
    name: 'get_business_information',
    description:
      'Informacoes da empresa: nome, endereco, telefone, horario de funcionamento e politicas de pagamento e cancelamento.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'get_services',
    description: 'Lista os servicos disponiveis com preco e duracao em minutos.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'get_available_slots',
    description:
      'Horarios livres em uma data para a combinacao de servicos escolhida. Use SEMPRE antes de sugerir qualquer horario - nunca invente horarios.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        service_ids: { type: 'array', items: { type: 'string' }, description: 'IDs dos servicos' },
        professional_id: { type: 'string', description: 'ID do profissional (opcional)' },
      },
      required: ['date', 'service_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_appointment',
    description:
      'Cria o agendamento. Use apenas depois de confirmar com o cliente: servicos, data, horario e nome. O horario precisa ter vindo de get_available_slots.',
    input_schema: {
      type: 'object' as const,
      properties: {
        starts_at: { type: 'string', description: 'Inicio no formato ISO 8601 devolvido por get_available_slots' },
        service_ids: { type: 'array', items: { type: 'string' } },
        professional_id: { type: 'string' },
        client_name: { type: 'string' },
      },
      required: ['starts_at', 'service_ids', 'client_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_customer_appointments',
    description: 'Agendamentos futuros do cliente que esta conversando neste numero de WhatsApp.',
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'reschedule_appointment',
    description: 'Remarca um agendamento do cliente para outro horario ja confirmado como livre.',
    input_schema: {
      type: 'object' as const,
      properties: {
        appointment_id: { type: 'string' },
        starts_at: { type: 'string', description: 'Novo inicio em ISO 8601' },
      },
      required: ['appointment_id', 'starts_at'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela um agendamento do cliente, respeitando a politica de antecedencia da empresa.',
    input_schema: {
      type: 'object' as const,
      properties: {
        appointment_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['appointment_id'],
      additionalProperties: false,
    },
  },
];

async function clientAppointments(ctx: ToolContext) {
  const phone = normalizePhone(ctx.phone);
  return query(
    `SELECT a.id, a.starts_at, a.status, a.total_amount::float8 AS total_amount,
            a.paid_amount::float8 AS paid_amount,
            (SELECT g.manage_token FROM appointments g
              WHERE g.booking_group_id = a.booking_group_id AND g.manage_token IS NOT NULL LIMIT 1) AS manage_token,
            p.name AS professional_name,
            COALESCE((SELECT string_agg(s.service_name, ' + ' ORDER BY s.position)
                        FROM appointment_services s WHERE s.appointment_id = a.id), '') AS services
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN professionals p ON p.id = a.professional_id
      WHERE a.tenant_id = $1 AND c.phone = $2
        AND a.starts_at > now() AND a.status IN ('pending','confirmed')
      ORDER BY a.starts_at`,
    [ctx.tenantId, phone]
  );
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const { tenant, settings } = await getTenantContext(ctx.tenantId);
  const tz = tenant.timezone;

  switch (name) {
    case 'get_business_information': {
      const hours = await query<{ weekday: number; opens_at: string; closes_at: string }>(
        `SELECT weekday, opens_at::text AS opens_at, closes_at::text AS closes_at
           FROM business_hours WHERE tenant_id = $1 AND professional_id IS NULL AND active
           ORDER BY weekday`,
        [ctx.tenantId]
      );
      const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
      return {
        nome: tenant.name,
        endereco: tenant.address,
        telefone: tenant.phone,
        hoje: `${formatDateBR(todayInTz(tz))} (${dias[new Date().getDay()]})`,
        fuso: tz,
        horario_funcionamento: hours.map((h) => `${dias[h.weekday]}: ${h.opens_at.slice(0, 5)} as ${h.closes_at.slice(0, 5)}`),
        pagamento: {
          exige_pagamento_online: settings.online_payment_required,
          percentual_sinal: Number(settings.deposit_percent),
          metodos: settings.payment_methods,
        },
        politica_cancelamento: `Alteracoes e cancelamentos ate ${Math.round(settings.minimum_reschedule_notice_minutes / 60)}h antes do horario.`,
        link_agendamento: `${env.appUrl}/agendar/${tenant.slug}`,
      };
    }

    case 'get_services': {
      const services = await query<{ id: string; name: string; price: number; duration_minutes: number }>(
        `SELECT id, name, price::float8 AS price, duration_minutes
           FROM services WHERE tenant_id = $1 AND active ORDER BY display_order, name`,
        [ctx.tenantId]
      );
      return services.map((s) => ({
        id: s.id,
        nome: s.name,
        preco: money(s.price),
        duracao_minutos: s.duration_minutes,
      }));
    }

    case 'get_available_slots': {
      const result = await getDayAvailability({
        tenantId: ctx.tenantId,
        date: String(input.date),
        serviceIds: (input.service_ids as string[]) ?? [],
        professionalId: (input.professional_id as string) ?? null,
      });
      return {
        data: formatDateBR(result.date),
        duracao_total_minutos: result.totalDurationMinutes,
        valor_total: money(result.totalAmount),
        cabe_tudo_junto: result.fitsTogether,
        horarios: result.slots.map((s) => ({
          hora: s.time,
          starts_at: s.startsAt,
          profissional: s.professionalName,
          professional_id: s.professionalId,
        })),
        // quando nao ha bloco continuo, o cliente pode escolher horarios separados
        alternativa_horarios_separados: result.perService?.map((p) => ({
          servico: p.name,
          horarios: p.slots.slice(0, 8).map((s) => ({ hora: s.time, starts_at: s.startsAt })),
        })),
      };
    }

    case 'create_appointment': {
      const booking = await createBooking({
        tenantId: ctx.tenantId,
        items: [
          {
            startsAt: String(input.starts_at),
            serviceIds: (input.service_ids as string[]) ?? [],
            professionalId: (input.professional_id as string) ?? null,
          },
        ],
        client: { name: String(input.client_name), phone: ctx.phone },
        source: 'ai',
        requirePayment: settings.online_payment_required,
      });

      const zoned = utcToZoned(new Date(booking.appointments[0].startsAt), tz);
      return {
        criado: true,
        status: booking.status,
        data: formatDateBR(zoned.dateStr),
        hora: zoned.timeStr,
        valor_total: money(booking.totalAmount),
        precisa_pagamento: settings.online_payment_required,
        link_gerenciar: `${env.appUrl}/agendamento/${booking.manageToken}`,
        aviso: settings.online_payment_required
          ? `Reserva guardada por ${settings.hold_expiration_minutes} minutos ate o pagamento pelo link.`
          : 'Agendamento confirmado.',
      };
    }

    case 'get_customer_appointments': {
      const rows = await clientAppointments(ctx);
      return rows.map((a: Record<string, any>) => {
        const zoned = utcToZoned(new Date(a.starts_at), tz);
        return {
          id: a.id,
          data: formatDateBR(zoned.dateStr),
          hora: zoned.timeStr,
          servicos: a.services,
          profissional: a.professional_name,
          status: a.status,
          total: money(a.total_amount),
          pago: money(a.paid_amount),
          restante: money(Math.max(0, a.total_amount - a.paid_amount)),
        };
      });
    }

    case 'reschedule_appointment': {
      const rows = await clientAppointments(ctx);
      const target = rows.find((a: Record<string, any>) => a.id === input.appointment_id);
      if (!target) return { erro: 'Este agendamento nao pertence a este numero.' };

      const updated = await rescheduleAppointment({
        tenantId: ctx.tenantId,
        appointmentId: String(input.appointment_id),
        startsAt: String(input.starts_at),
        enforceNotice: true,
        ip: 'whatsapp-ai',
      });
      const zoned = utcToZoned(new Date(updated.starts_at), tz);
      return { remarcado: true, data: formatDateBR(zoned.dateStr), hora: zoned.timeStr };
    }

    case 'cancel_appointment': {
      const rows = await clientAppointments(ctx);
      const target = rows.find((a: Record<string, any>) => a.id === input.appointment_id) as
        | Record<string, any>
        | undefined;
      if (!target?.manage_token) return { erro: 'Este agendamento nao pertence a este numero.' };

      await cancelByClient({
        token: target.manage_token,
        appointmentId: String(input.appointment_id),
        reason: (input.reason as string) ?? 'Cancelado pelo WhatsApp',
      });
      return { cancelado: true };
    }

    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}

export { getBookingByToken, queryOne };
