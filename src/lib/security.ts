import { z } from 'zod';

/**
 * Guardas de borda que não cabem em nenhuma rota específica.
 *
 * O tema aqui é sempre o mesmo: dado que o usuário digita e o **servidor** vai
 * buscar depois. Uma URL de imagem parece inofensiva até o otimizador do
 * next/image sair buscando ela de dentro da nossa rede.
 */

/** Hosts que o servidor nunca deve buscar por ordem de um usuário. */
const HOSTS_PROIBIDOS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
];

/**
 * Faixas privadas, loopback e link-local em v4/v6.
 *
 * 169.254.169.254 é o endereço de metadados de AWS/GCP/Azure: é por ele que um
 * SSRF vira credencial de nuvem vazada. Ele cai na faixa link-local abaixo.
 */
const IPS_PROIBIDOS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/** Endereço que o servidor pode buscar sem virar porta de entrada para a rede interna. */
export function isSafeRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // http:// abre espaço para interceptação e não é aceitável para conteúdo nosso
  if (url.protocol !== 'https:') return false;
  // usuario:senha@host esconde o destino real e não tem uso legítimo aqui
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (HOSTS_PROIBIDOS.some((re) => re.test(host))) return false;
  if (IPS_PROIBIDOS.some((re) => re.test(host))) return false;

  return true;
}

/**
 * Campo de imagem vinda de fora (logo, foto do profissional, foto do produto).
 *
 * Enquanto o upload não existe, essas URLs apontam para qualquer lugar da
 * internet e o servidor as busca para otimizar. Sem esta trava, o painel vira
 * um proxy: bastaria salvar `https://169.254.169.254/...` como logo para fazer
 * a nossa infraestrutura buscar o endpoint de metadados da nuvem e devolver o
 * resultado como se fosse uma imagem.
 */
export const imageUrlSchema = z
  .string()
  .trim()
  .max(2048, 'URL muito longa')
  .refine(isSafeRemoteUrl, 'Informe uma URL https pública (endereços internos não são aceitos)');
