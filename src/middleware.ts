import { NextResponse, type NextRequest } from 'next/server';

/**
 * Portao leve do painel: so verifica se existe cookie de sessao para nao
 * mostrar a tela vazia a quem nao esta logado. A validacao real do token e do
 * tenant acontece em cada rota da API - nunca confiamos so nisto.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has('ag_access') || req.cookies.has('ag_refresh');

  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
