import { addDays, todayInTz } from '@/lib/datetime';

/** Traduz o filtro do painel (hoje/semana/mes/personalizado) em datas locais da empresa. */
export function resolvePeriod(
  range: string,
  timezone: string,
  from?: string,
  to?: string
): { from: string; to: string } {
  const today = todayInTz(timezone);

  if (range === 'custom' && from) return { from, to: to ?? from };

  if (range === 'week') {
    const [y, m, d] = today.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const start = addDays(today, -weekday);
    return { from: start, to: addDays(start, 6) };
  }

  if (range === 'month') {
    const [y, m] = today.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      from: `${today.slice(0, 7)}-01`,
      to: `${today.slice(0, 7)}-${String(days).padStart(2, '0')}`,
    };
  }

  return { from: today, to: today };
}
