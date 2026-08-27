/**
 * Utilitarios de data/hora com fuso por tenant.
 *
 * Regra do projeto: no banco tudo e timestamptz (instante absoluto). Horario
 * de funcionamento, bloqueios semanais e o que o cliente ve sao sempre no fuso
 * da empresa. A conversao acontece so aqui, usando Intl - sem dependencia extra
 * e sem tabela de fusos desatualizada.
 */

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = domingo
  dateStr: string; // YYYY-MM-DD
  timeStr: string; // HH:mm
  minutesOfDay: number;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Deslocamento do fuso, em ms, no instante informado (respeita horario de verao). */
function offsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  ) as Record<string, string>;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/** 'YYYY-MM-DD' + minutos do dia (no fuso do tenant) -> instante UTC. */
export function zonedToUtc(dateStr: string, minutesOfDay: number, timeZone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesOfDay * 60_000;
  // Duas passadas resolvem a borda do horario de verao.
  let ts = naive - offsetMs(new Date(naive), timeZone);
  ts = naive - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Instante -> partes no fuso do tenant. */
export function utcToZoned(date: Date, timeZone: string): ZonedParts {
  const shifted = new Date(date.getTime() + offsetMs(date, timeZone));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: shifted.getUTCDay(),
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
    timeStr: `${pad(hour)}:${pad(minute)}`,
    minutesOfDay: hour * 60 + minute,
  };
}

export function todayInTz(timeZone: string, ref: Date = new Date()): string {
  return utcToZoned(ref, timeZone).dateStr;
}

/** Dia da semana de uma data calendario (0 = domingo). Independe do fuso. */
export function weekdayOfDate(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** '09:30' | '09:30:00' -> 570 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 570 -> '09:30' */
export function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export const WEEKDAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const MONTH_LABELS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** '2026-08-27' -> '27/08/2026' */
export function formatDateBR(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export function formatDateLong(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAY_LABELS[weekdayOfDate(dateStr)]}, ${d} de ${MONTH_LABELS[m - 1]} de ${y}`;
}

export function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}
