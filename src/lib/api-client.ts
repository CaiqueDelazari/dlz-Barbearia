'use client';

/** Cliente HTTP do frontend. Toda chamada passa por /api/v1 - nada de acesso direto ao banco. */

export type ApiErrorShape = { message: string; code: string; details?: unknown };

export class ApiClientError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
    cache: 'no-store',
  });

  let payload: { data?: T; error?: ApiErrorShape } = {};
  try {
    payload = await res.json();
  } catch {
    // resposta sem corpo
  }

  if (!res.ok) {
    const error = payload.error;
    // 401 no painel: a sessao caiu, tenta renovar uma vez antes de desistir
    if (res.status === 401 && !path.startsWith('/auth/')) {
      const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
      if (refreshed.ok) return request<T>(path, init);
    }
    throw new ApiClientError(
      res.status,
      error?.message ?? 'Nao foi possivel completar a acao',
      error?.code ?? 'error',
      error?.details
    );
  }

  return payload.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const money = (value: number | string) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);

export const shortMoney = (value: number | string) =>
  `R$ ${(Number(value) || 0).toFixed(2).replace('.', ',')}`;
