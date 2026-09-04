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
 * Arquivo servido pelo nosso próprio `public/` — `/riady/riady.jpg`.
 *
 * Não passa por `isSafeRemoteUrl` porque não é endereço de rede: é caminho de
 * arquivo estático nosso, que nós mesmos colocamos no repositório.
 *
 * Três recusas, e cada uma fecha um jeito diferente de o caminho deixar de ser
 * um arquivo do `public/`:
 *
 * - `//host/x.jpg` não é caminho, é URL sem esquema: o navegador (e o
 *   otimizador) buscariam em `host`, que é exatamente o que a trava remota
 *   existe para impedir.
 * - `..` sairia de `public/`.
 * - `/api/` é rota nossa, não arquivo. A extensão obrigatória já barraria
 *   `/api/v1/appointments`, mas não barraria alguém criando uma rota que
 *   termine em `.jpg` — então o prefixo é recusado por nome, e o otimizador
 *   de imagem nunca vira um jeito de chamar nossas rotas sem sessão.
 */
function isCaminhoLocalDeImagem(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('..')) return false;
  if (/^\/api\//i.test(value)) return false;
  return /^\/[A-Za-z0-9._~\-/]+\.(png|jpe?g|webp|avif|gif)$/i.test(value);
}

/**
 * Campo de imagem (logo, foto do profissional, foto do produto).
 *
 * Aceita duas formas, e a diferença entre elas é quem hospeda o arquivo:
 *
 * 1. **URL https pública** — o dono cola o endereço de onde a imagem já mora.
 *    Enquanto o upload não existe, esse endereço aponta para qualquer lugar da
 *    internet e o servidor o busca para otimizar. Sem `isSafeRemoteUrl`, o
 *    painel viraria um proxy: bastaria salvar `https://169.254.169.254/...`
 *    como logo para a nossa infraestrutura buscar o endpoint de metadados da
 *    nuvem e devolver o resultado como se fosse uma imagem.
 *
 * 2. **Caminho local** — arquivo que vive no `public/` deste repositório. É o
 *    caso das imagens de implantação de um cliente, colocadas junto com o
 *    código antes de existir tela de upload.
 */
export const imageUrlSchema = z
  .string()
  .trim()
  .max(2048, 'URL muito longa')
  .refine(
    (v) => isCaminhoLocalDeImagem(v) || isSafeRemoteUrl(v),
    'Informe uma URL https pública ou um caminho de imagem do próprio site (endereços internos não são aceitos)'
  );
