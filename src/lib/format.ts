/** Formatadores compartilhados entre servidor e cliente. */

export function formatPhoneBR(phone: string): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone ?? '';
}

export function formatMoneyBR(value: number | string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}

export function formatTimeBR(value: string | Date, timeZone?: string): string {
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
}

export function formatDateTimeBR(value: string | Date, timeZone?: string): string {
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}
