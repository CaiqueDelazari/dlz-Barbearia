/**
 * Base dos testes de ponta a ponta.
 *
 * Cada arquivo de teste cria a PRÓPRIA empresa e a apaga no fim. Assim os
 * testes não dependem do seed, não sujam a demonstração e podem rodar em
 * paralelo sem um pisar no outro.
 *
 * O preparo usa a camada de serviço direto (rápido e sem esbarrar no rate
 * limit do /signup); o que está sob teste é sempre exercitado por HTTP, como
 * um cliente de verdade faria.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pool, query } from '@/lib/db';
import { createTenant } from '@/server/services/onboarding.service';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;

export type Resposta<T = any> = {
  status: number;
  data: T;
  error?: { message: string; code: string; details?: any };
};

/** Cliente HTTP com cookie jar próprio — um por usuário logado. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(public readonly label = 'anon') {}

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<Resposta<T>> {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data: json.data as T, error: json.error as Resposta['error'] };
  }

  get = <T = any>(path: string) => this.request<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.request<T>('POST', path, body);
  patch = <T = any>(path: string, body?: unknown) => this.request<T>('PATCH', path, body);
  del = <T = any>(path: string) => this.request<T>('DELETE', path);
}

export type Empresa = {
  tenantId: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
  /** Logado como dono (OWNER). */
  api: Client;
  /** Sem sessão: usado no fluxo público. */
  anon: Client;
  cleanup: () => Promise<void>;
};

/** Cria uma empresa isolada e já loga o dono. */
export async function criarEmpresa(prefixo = 'e2e'): Promise<Empresa> {
  const sufixo = randomUUID().slice(0, 8);
  const email = `dono-${sufixo}@teste.local`;
  const senha = 'senha-de-teste-123';

  const { tenantId, slug } = await createTenant({
    businessName: `${prefixo} ${sufixo}`,
    ownerName: 'Dona do Teste',
    email,
    password: senha,
    phone: '11999990000',
  });

  const api = new Client('owner');
  const login = await api.post('/auth/login', { email, password: senha, tenant: slug });
  if (login.status !== 200) {
    throw new Error(`login do dono falhou: ${JSON.stringify(login.error)}`);
  }

  return {
    tenantId,
    slug,
    ownerEmail: email,
    ownerPassword: senha,
    api,
    anon: new Client('anon'),
    cleanup: async () => {
      await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    },
  };
}

/** Encerra o pool para o processo de teste não ficar pendurado. */
export async function fecharPool() {
  await pool.end().catch(() => {});
}

// ------------------------------------------------------------------ datas
const pad = (n: number) => String(n).padStart(2, '0');

export function hojeLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Próximo dia útil a partir de `daysAhead` dias.
 * O horário padrão da empresa nova é seg–sex 09:00–19:00 e sábado 08:00–16:00,
 * então testes usam dia de semana para ter grade cheia e almoço no meio.
 */
export function diaUtil(daysAhead = 7): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function mesDe(data: string): string {
  return data.slice(0, 7);
}

// ------------------------------------------------------- atalhos de preparo
export async function criarServico(
  empresa: Empresa,
  data: { name: string; price: number; durationMinutes: number; category?: string; professionalIds?: string[] }
) {
  const r = await empresa.api.post('/services', data);
  if (r.status !== 201) throw new Error(`falha ao criar serviço: ${JSON.stringify(r.error)}`);
  return r.data.service as { id: string; name: string; price: number; durationMinutes: number };
}

export async function criarProfissional(empresa: Empresa, name: string, serviceIds: string[] = []) {
  const r = await empresa.api.post('/professionals', { name, serviceIds });
  if (r.status !== 201) throw new Error(`falha ao criar profissional: ${JSON.stringify(r.error)}`);
  return r.data.professional as { id: string; name: string };
}

export async function listarProfissionais(empresa: Empresa) {
  const r = await empresa.api.get('/professionals');
  return r.data.professionals as { id: string; name: string; active: boolean }[];
}

export async function ajustarConfig(empresa: Empresa, settings: Record<string, unknown>) {
  const r = await empresa.api.patch('/settings', { settings });
  if (r.status !== 200) throw new Error(`falha ao ajustar config: ${JSON.stringify(r.error)}`);
  return r.data;
}

/** Horários livres do dia para uma combinação de serviços. */
export async function horarios(
  empresa: Empresa,
  data: string,
  serviceIds: string[],
  professionalId?: string
) {
  const r = await empresa.anon.get(
    `/public/${empresa.slug}/availability?date=${data}&services=${serviceIds.join(',')}` +
      (professionalId ? `&professional=${professionalId}` : '')
  );
  if (r.status !== 200) throw new Error(`falha na disponibilidade: ${JSON.stringify(r.error)}`);
  return r.data as {
    slots: { time: string; startsAt: string; endsAt: string; professionalId: string | null }[];
    fitsTogether: boolean;
    totalDurationMinutes: number;
    totalAmount: number;
    perService?: { serviceId: string; name: string; slots: { time: string; startsAt: string }[] }[];
  };
}

/** Agendamento pelo painel (sem rate limit e sem exigir pagamento). */
export async function agendarPeloPainel(
  empresa: Empresa,
  input: { startsAt: string; serviceIds: string[]; professionalId?: string | null; nome?: string; telefone?: string }
) {
  const r = await empresa.api.post('/appointments', {
    items: [
      { startsAt: input.startsAt, serviceIds: input.serviceIds, professionalId: input.professionalId ?? null },
    ],
    client: { name: input.nome ?? 'Cliente Teste', phone: input.telefone ?? '11988887777' },
  });
  if (r.status !== 201) throw new Error(`falha ao agendar: ${JSON.stringify(r.error)}`);
  return r.data as {
    bookingGroupId: string;
    manageToken: string;
    totalAmount: number;
    appointments: { id: string; startsAt: string; endsAt: string }[];
  };
}

export const dinheiro = (v: unknown) => Number(Number(v).toFixed(2));
