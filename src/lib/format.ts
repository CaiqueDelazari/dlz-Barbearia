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

/**
 * Aceita "@perfil", "perfil" ou a URL inteira colada do navegador.
 *
 * Quem preenche isso é o dono do estúdio, na tela de Configurações, e cada um
 * digita de um jeito. Normalizar aqui é mais barato do que exigir um formato
 * na hora de salvar e devolver erro para quem só queria colar o link.
 */
export function perfilInstagram(valor: string | null): { url: string; handle: string } | null {
  const bruto = valor?.trim();
  if (!bruto) return null;

  const handle = bruto
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .trim();

  return handle ? { url: `https://instagram.com/${handle}`, handle: `@${handle}` } : null;
}

/**
 * Link de conversa no WhatsApp, com a mensagem ja escrita.
 *
 * O numero sai do cadastro da empresa, digitado a mao ("(11) 91234-5678"), e o
 * wa.me so aceita digitos com o codigo do pais na frente. A regra do 55 e a
 * mesma de `toWhatsappNumber` no servidor; esta copia existe porque aquela vive
 * junto do banco e nao pode ser importada por componente de tela.
 *
 * Devolve `null` quando nao ha numero -- e a tela esconde o botao em vez de
 * oferecer um link que abre uma conversa com ninguem.
 */
export function linkWhatsapp(phone: string | null | undefined, message?: string): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  const numero = d.startsWith('55') ? d : `55${d}`;
  const texto = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${numero}${texto}`;
}
