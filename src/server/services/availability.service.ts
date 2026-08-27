import { query } from '@/lib/db';
import { ApiError } from '@/lib/http';
import { addDays, minutesToTime, timeToMinutes, todayInTz, utcToZoned, weekdayOfDate, zonedToUtc } from '@/lib/datetime';
import type { BusinessSettings, Professional, Service, Slot, Tenant } from '../types';
import { getTenantContext } from '../repositories/tenant.repo';

/** Intervalo absoluto em epoch ms. Toda a matematica de agenda roda assim. */
export type Interval = { start: number; end: number };

type HourRow = { professional_id: string | null; weekday: number; opens_at: string; closes_at: string };
type BreakRow = { professional_id: string | null; weekday: number; starts_at: string; ends_at: string };
type BlockRow = { professional_id: string | null; starts_at: Date; ends_at: Date };
type BusyRow = { professional_id: string | null; starts_at: Date; ends_at: Date };

export type AgendaContext = {
  tenant: Tenant;
  settings: BusinessSettings;
  professionals: Professional[];
  hours: HourRow[];
  breaks: BreakRow[];
  blocks: BlockRow[];
  busy: BusyRow[];
};

// --------------------------------------------------------------- intervalos
function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let result = base;
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const iv of result) {
      if (cut.end <= iv.start || cut.start >= iv.end) {
        next.push(iv);
        continue;
      }
      if (cut.start > iv.start) next.push({ start: iv.start, end: cut.start });
      if (cut.end < iv.end) next.push({ start: cut.end, end: iv.end });
    }
    result = next;
  }
  return result.filter((iv) => iv.end > iv.start);
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

// ------------------------------------------------------------- carregamento
/**
 * Carrega de uma vez tudo que a agenda precisa no periodo. Calcular mes inteiro
 * dia a dia com query por dia nao escala - aqui e uma leitura so.
 */
export async function loadAgendaContext(
  tenantId: string,
  fromDate: string,
  toDate: string,
  professionalId?: string | null
): Promise<AgendaContext> {
  const { tenant, settings } = await getTenantContext(tenantId);
  const tz = tenant.timezone;
  const rangeStart = zonedToUtc(fromDate, 0, tz);
  const rangeEnd = zonedToUtc(addDays(toDate, 1), 0, tz);

  const [professionals, hours, breaks, blocks, busy] = await Promise.all([
    query<Professional>(
      `SELECT id, tenant_id, name, bio, photo_url, display_order, active
         FROM professionals
        WHERE tenant_id = $1 AND active
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY display_order, name`,
      [tenantId, professionalId ?? null]
    ),
    query<HourRow>(
      `SELECT professional_id, weekday, opens_at::text, closes_at::text
         FROM business_hours WHERE tenant_id = $1 AND active`,
      [tenantId]
    ),
    query<BreakRow>(
      `SELECT professional_id, weekday, starts_at::text, ends_at::text
         FROM business_breaks WHERE tenant_id = $1`,
      [tenantId]
    ),
    query<BlockRow>(
      `SELECT professional_id, starts_at, ends_at
         FROM blocked_periods
        WHERE tenant_id = $1 AND ends_at > $2 AND starts_at < $3`,
      [tenantId, rangeStart, rangeEnd]
    ),
    query<BusyRow>(
      `SELECT professional_id, starts_at, ends_at
         FROM appointments
        WHERE tenant_id = $1 AND ends_at > $2 AND starts_at < $3
          AND (
            status IN ('confirmed', 'completed')
            OR (status = 'pending' AND (hold_expires_at IS NULL OR hold_expires_at > now()))
          )`,
      [tenantId, rangeStart, rangeEnd]
    ),
  ]);

  return { tenant, settings, professionals, hours, breaks, blocks, busy };
}

// ------------------------------------------------------------------ janelas
/**
 * EXPEDIENTE - substituicao: se o profissional tem horario proprio cadastrado,
 * ele manda. Sem horario proprio, vale o horario da empresa.
 */
function hoursFor<T extends { professional_id: string | null; weekday: number }>(
  rows: T[],
  professionalId: string | null,
  weekday: number
): T[] {
  const own = rows.filter((r) => r.professional_id === professionalId && r.weekday === weekday);
  if (professionalId && own.length) return own;
  const hasOwnAnyDay = professionalId ? rows.some((r) => r.professional_id === professionalId) : false;
  if (hasOwnAnyDay) return own; // tem agenda propria mas nao trabalha nesse dia
  return rows.filter((r) => r.professional_id === null && r.weekday === weekday);
}

/**
 * PAUSAS - soma, nunca substituicao.
 *
 * O almoco da casa continua valendo para quem tem pausa propria: uma folga
 * pessoal da Larissa nao pode reabrir o horario em que o estudio esta fechado.
 */
function breaksFor<T extends { professional_id: string | null; weekday: number }>(
  rows: T[],
  professionalId: string | null,
  weekday: number
): T[] {
  return rows.filter(
    (r) =>
      r.weekday === weekday &&
      (r.professional_id === null || r.professional_id === professionalId)
  );
}

/** Janelas livres do profissional no dia, ja descontando pausas, bloqueios e agenda. */
export function freeIntervals(
  ctx: AgendaContext,
  dateStr: string,
  professionalId: string | null
): Interval[] {
  const tz = ctx.tenant.timezone;
  const weekday = weekdayOfDate(dateStr);

  const windows = hoursFor(ctx.hours, professionalId, weekday).map((h) => ({
    start: zonedToUtc(dateStr, timeToMinutes(h.opens_at), tz).getTime(),
    end: zonedToUtc(dateStr, timeToMinutes(h.closes_at), tz).getTime(),
  }));
  if (!windows.length) return [];

  const cuts: Interval[] = [];

  for (const b of breaksFor(ctx.breaks, professionalId, weekday)) {
    cuts.push({
      start: zonedToUtc(dateStr, timeToMinutes(b.starts_at), tz).getTime(),
      end: zonedToUtc(dateStr, timeToMinutes(b.ends_at), tz).getTime(),
    });
  }

  // bloqueio da empresa vale para todos; bloqueio do profissional so para ele
  for (const b of ctx.blocks) {
    if (b.professional_id && b.professional_id !== professionalId) continue;
    cuts.push({ start: new Date(b.starts_at).getTime(), end: new Date(b.ends_at).getTime() });
  }

  for (const a of ctx.busy) {
    if (a.professional_id !== professionalId) continue;
    cuts.push({ start: new Date(a.starts_at).getTime(), end: new Date(a.ends_at).getTime() });
  }

  return subtract(merge(windows), cuts);
}

/**
 * Horarios em que cabe um bloco continuo de `durationMinutes`.
 * A grade parte do horario de abertura do dia (nao do inicio do buraco livre),
 * para o cliente ver 09:00 / 09:30 / 10:00 e nao 09:07.
 */
export function slotStartsFor(
  ctx: AgendaContext,
  dateStr: string,
  professionalId: string | null,
  durationMinutes: number,
  now: number
): number[] {
  const tz = ctx.tenant.timezone;
  const weekday = weekdayOfDate(dateStr);
  const windows = hoursFor(ctx.hours, professionalId, weekday);
  if (!windows.length) return [];

  const free = freeIntervals(ctx, dateStr, professionalId);
  if (!free.length) return [];

  const step = ctx.settings.slot_interval_minutes * 60_000;
  const durationMs = durationMinutes * 60_000;
  const minStart = now + ctx.settings.min_advance_minutes * 60_000;

  const starts: number[] = [];
  for (const w of windows) {
    const gridStart = zonedToUtc(dateStr, timeToMinutes(w.opens_at), tz).getTime();
    const gridEnd = zonedToUtc(dateStr, timeToMinutes(w.closes_at), tz).getTime();
    for (let t = gridStart; t + durationMs <= gridEnd; t += step) {
      if (t < minStart) continue;
      const fits = free.some((iv) => iv.start <= t && t + durationMs <= iv.end);
      if (fits) starts.push(t);
    }
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

// -------------------------------------------------------------- disponibilidade
export type DayAvailability = {
  date: string;
  timezone: string;
  totalDurationMinutes: number;
  totalAmount: number;
  /** true = da para fazer tudo emendado */
  fitsTogether: boolean;
  slots: Slot[];
  /** Preenchido quando nao ha bloco continuo e a empresa aceita horarios separados */
  perService?: { serviceId: string; name: string; durationMinutes: number; price: number; slots: Slot[] }[];
};

function toSlot(ctx: AgendaContext, start: number, professionalId: string | null, durationMinutes: number): Slot {
  const prof = ctx.professionals.find((p) => p.id === professionalId) ?? null;
  return {
    time: utcToZoned(new Date(start), ctx.tenant.timezone).timeStr,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + durationMinutes * 60_000).toISOString(),
    professionalId,
    professionalName: prof?.name ?? null,
  };
}

/** Recursos que podem atender: profissionais ativos, ou [null] se a empresa nao cadastrou nenhum. */
function resourcesFor(ctx: AgendaContext, allowedProfessionalIds: Set<string> | null): (string | null)[] {
  if (!ctx.professionals.length) return [null];
  return ctx.professionals
    .filter((p) => !allowedProfessionalIds || allowedProfessionalIds.has(p.id))
    .map((p) => p.id);
}

/**
 * Quem atende TODOS os servicos escolhidos. Servico sem vinculo em
 * professional_services e atendido por todo mundo.
 */
export async function professionalsForServices(
  tenantId: string,
  serviceIds: string[]
): Promise<Set<string> | null> {
  if (!serviceIds.length) return null;
  const rows = await query<{ service_id: string; professional_id: string }>(
    `SELECT service_id, professional_id FROM professional_services
      WHERE tenant_id = $1 AND service_id = ANY($2::uuid[])`,
    [tenantId, serviceIds]
  );
  if (!rows.length) return null;

  const byService = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byService.has(r.service_id)) byService.set(r.service_id, new Set());
    byService.get(r.service_id)!.add(r.professional_id);
  }

  let intersection: Set<string> | null = null;
  for (const serviceId of serviceIds) {
    const set = byService.get(serviceId);
    if (!set) continue; // servico livre para todos
    if (!intersection) {
      intersection = new Set(set);
      continue;
    }
    const previous: Set<string> = intersection;
    intersection = new Set([...set].filter((id) => previous.has(id)));
  }
  return intersection;
}

export async function loadServices(tenantId: string, serviceIds: string[]): Promise<Service[]> {
  if (!serviceIds.length) throw ApiError.badRequest('Selecione ao menos um servico');
  const rows = await query<Service>(
    `SELECT id, tenant_id, name, description, price::float8 AS price, duration_minutes,
            image_url, category, display_order, active
       FROM services
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND active`,
    [tenantId, serviceIds]
  );
  if (rows.length !== new Set(serviceIds).size) {
    throw ApiError.badRequest('Algum servico selecionado nao existe ou esta inativo');
  }
  // preserva a ordem escolhida pelo cliente
  return serviceIds.map((id) => rows.find((s) => s.id === id)!);
}

export async function getDayAvailability(input: {
  tenantId: string;
  date: string;
  serviceIds: string[];
  professionalId?: string | null;
  now?: Date;
}): Promise<DayAvailability> {
  const now = (input.now ?? new Date()).getTime();
  const services = await loadServices(input.tenantId, input.serviceIds);
  const totalDuration = services.reduce((sum, s) => sum + s.duration_minutes, 0);
  const totalAmount = services.reduce((sum, s) => sum + Number(s.price), 0);

  const ctx = await loadAgendaContext(input.tenantId, input.date, input.date, input.professionalId);
  const allowed = await professionalsForServices(input.tenantId, input.serviceIds);
  const resources = resourcesFor(ctx, allowed);

  // um horario aparece uma vez; guardamos qual profissional o cobre
  const combined = new Map<number, string | null>();
  for (const resource of resources) {
    for (const start of slotStartsFor(ctx, input.date, resource, totalDuration, now)) {
      if (!combined.has(start)) combined.set(start, resource);
    }
  }

  const slots = [...combined.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, prof]) => toSlot(ctx, start, prof, totalDuration));

  const result: DayAvailability = {
    date: input.date,
    timezone: ctx.tenant.timezone,
    totalDurationMinutes: totalDuration,
    totalAmount,
    fitsTogether: slots.length > 0,
    slots,
  };

  // Sem bloco continuo: oferecer horarios separados por servico (secao 12).
  if (!slots.length && services.length > 1 && ctx.settings.allow_split_appointments) {
    result.perService = services.map((service) => {
      const perResource = new Map<number, string | null>();
      for (const resource of resources) {
        for (const start of slotStartsFor(ctx, input.date, resource, service.duration_minutes, now)) {
          if (!perResource.has(start)) perResource.set(start, resource);
        }
      }
      return {
        serviceId: service.id,
        name: service.name,
        durationMinutes: service.duration_minutes,
        price: Number(service.price),
        slots: [...perResource.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([start, prof]) => toSlot(ctx, start, prof, service.duration_minutes)),
      };
    });
  }

  return result;
}

/** Dias do mes com pelo menos um horario livre - alimenta o calendario. */
export async function getMonthAvailability(input: {
  tenantId: string;
  month: string; // YYYY-MM
  serviceIds: string[];
  professionalId?: string | null;
  now?: Date;
}): Promise<{ month: string; days: { date: string; available: boolean }[] }> {
  const now = (input.now ?? new Date()).getTime();
  const services = await loadServices(input.tenantId, input.serviceIds);
  const totalDuration = services.reduce((sum, s) => sum + s.duration_minutes, 0);

  const [year, month] = input.month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const first = `${input.month}-01`;
  const last = `${input.month}-${String(daysInMonth).padStart(2, '0')}`;

  const ctx = await loadAgendaContext(input.tenantId, first, last, input.professionalId);
  const allowed = await professionalsForServices(input.tenantId, input.serviceIds);
  const resources = resourcesFor(ctx, allowed);

  const today = todayInTz(ctx.tenant.timezone, new Date(now));
  const limit = addDays(today, ctx.settings.max_advance_days);

  const days: { date: string; available: boolean }[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${input.month}-${String(d).padStart(2, '0')}`;
    if (date < today || date > limit) {
      days.push({ date, available: false });
      continue;
    }
    const available = resources.some(
      (resource) => slotStartsFor(ctx, date, resource, totalDuration, now).length > 0
    );
    days.push({ date, available });
  }
  return { month: input.month, days };
}

/**
 * Revalidacao final, dentro da transacao de criacao. E aqui que o double
 * booking morre: o SELECT roda depois do advisory lock do profissional.
 */
export function assertSlotFree(
  ctx: AgendaContext,
  professionalId: string | null,
  startsAt: Date,
  endsAt: Date,
  dateStr: string
): void {
  const start = startsAt.getTime();
  const end = endsAt.getTime();
  const free = freeIntervals(ctx, dateStr, professionalId);
  const fits = free.some((iv) => iv.start <= start && end <= iv.end);
  if (!fits) {
    throw ApiError.conflict(
      'Este horario nao esta mais disponivel. Escolha outro.',
      'slot_taken'
    );
  }
}

export { minutesToTime, timeToMinutes };
