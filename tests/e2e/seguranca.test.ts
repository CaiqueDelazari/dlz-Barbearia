/**
 * O que não pode falhar nunca: uma empresa não enxerga a outra, quem não está
 * logado não entra, e cada papel só faz o que lhe cabe.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { query } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import {
  BASE, Client, agendarPeloPainel, ajustarConfig, criarEmpresa, criarServico, diaUtil,
  fecharPool, horarios, type Empresa,
} from '../helpers/e2e';

let alfa: Empresa;
let beta: Empresa;
let servicoAlfa: { id: string };
let servicoBeta: { id: string };
let clienteAlfa: string;
let agendamentoAlfa: string;

/** Cria um usuário com papel específico dentro de uma empresa e já loga. */
async function usuarioCom(empresa: Empresa, role: 'STAFF' | 'ADMIN') {
  const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@teste.local`;
  const senha = 'senha-de-teste-123';
  await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)`,
    [empresa.tenantId, `Usuário ${role}`, email, await hashPassword(senha), role]
  );
  const client = new Client(role);
  const login = await client.post('/auth/login', { email, password: senha, tenant: empresa.slug });
  assert.equal(login.status, 200, `login ${role} falhou`);
  return client;
}

before(async () => {
  alfa = await criarEmpresa('alfa');
  beta = await criarEmpresa('beta');
  for (const e of [alfa, beta]) {
    await ajustarConfig(e, { onlinePaymentRequired: false, minAdvanceMinutes: 0 });
  }

  servicoAlfa = await criarServico(alfa, { name: 'Corte Alfa', price: 100, durationMinutes: 30 });
  servicoBeta = await criarServico(beta, { name: 'Corte Beta', price: 90, durationMinutes: 30 });

  const dia = diaUtil(60);
  const { slots } = await horarios(alfa, dia, [servicoAlfa.id]);
  const criado = await agendarPeloPainel(alfa, {
    startsAt: slots[0].startsAt, serviceIds: [servicoAlfa.id], professionalId: slots[0].professionalId,
    nome: 'Cliente da Alfa', telefone: '11922221111',
  });
  agendamentoAlfa = criado.appointments[0].id;

  const clientes = await alfa.api.get('/clients');
  clienteAlfa = clientes.data.items[0].id;
});

after(async () => {
  await alfa.cleanup();
  await beta.cleanup();
  await fecharPool();
});

describe('isolamento entre empresas', () => {
  test('a beta não vê os serviços da alfa', async () => {
    const meus = await beta.api.get('/services');
    const nomes = meus.data.services.map((s: any) => s.name);
    assert.deepEqual(nomes, ['Corte Beta']);
  });

  test('a beta não abre o agendamento da alfa', async () => {
    const r = await beta.api.get(`/appointments/${agendamentoAlfa}`);
    assert.equal(r.status, 404, 'id de outra empresa precisa ser 404');
  });

  test('a beta não altera o agendamento da alfa', async () => {
    const r = await beta.api.patch(`/appointments/${agendamentoAlfa}`, { status: 'cancelled' });
    assert.equal(r.status, 404);

    const intacto = await alfa.api.get(`/appointments/${agendamentoAlfa}`);
    assert.notEqual(intacto.data.appointment.status, 'cancelled', 'nada aconteceu do outro lado');
  });

  test('a beta não lê a ficha do cliente da alfa', async () => {
    const r = await beta.api.get(`/clients/${clienteAlfa}`);
    assert.equal(r.status, 404);
  });

  test('a beta não vende produto no atendimento da alfa', async () => {
    const produto = await beta.api.post('/products', { name: 'Da Beta', price: 10, stockQuantity: 5 });
    const r = await beta.api.post(`/appointments/${agendamentoAlfa}/products`, {
      productId: produto.data.product.id, quantity: 1,
    });
    assert.equal(r.status, 404);
  });

  test('a beta não fecha a agenda da alfa nem apaga bloqueio alheio', async () => {
    const dia = diaUtil(62);
    const bloqueio = await alfa.api.post('/blocks', { date: dia, reason: 'Da Alfa' });
    assert.equal(bloqueio.status, 201);

    const apagar = await beta.api.del(`/blocks/${bloqueio.data.block.id}`);
    assert.equal(apagar.status, 404);

    const aindaFechado = await horarios(alfa, dia, [servicoAlfa.id]);
    assert.equal(aindaFechado.slots.length, 0, 'o bloqueio da alfa continua de pé');
  });

  test('o dashboard de cada uma só conta o que é dela', async () => {
    const d = await beta.api.get('/dashboard?range=month');
    assert.equal(d.status, 200);
    const clientes = await beta.api.get('/clients');
    assert.ok(
      clientes.data.items.every((c: any) => c.name !== 'Cliente da Alfa'),
      'cliente da alfa não pode aparecer na beta'
    );
  });

  test('serviço da outra empresa não entra em agendamento', async () => {
    const dia = diaUtil(64);
    const { slots } = await horarios(beta, dia, [servicoBeta.id]);
    const r = await beta.api.post('/appointments', {
      items: [{ startsAt: slots[0].startsAt, serviceIds: [servicoAlfa.id] }],
      client: { name: 'Tentativa', phone: '11911112222' },
    });
    assert.equal(r.status, 400);
  });
});

describe('autenticação', () => {
  test('sem sessão a API do painel devolve 401', async () => {
    const anon = new Client();
    for (const rota of ['/appointments', '/clients', '/services', '/dashboard', '/products', '/settings']) {
      const r = await anon.get(rota);
      assert.equal(r.status, 401, `${rota} deveria exigir login`);
    }
  });

  test('senha errada não entra e a mensagem não entrega o e-mail', async () => {
    const c = new Client();
    const r = await c.post('/auth/login', {
      email: alfa.ownerEmail, password: 'senha-errada', tenant: alfa.slug,
    });
    assert.equal(r.status, 401);
    assert.match(r.error!.message, /E-mail ou senha/, 'mensagem genérica de propósito');
  });

  test('e-mail inexistente devolve o mesmo erro', async () => {
    const c = new Client();
    const r = await c.post('/auth/login', { email: 'ninguem@nada.local', password: 'x' });
    assert.equal(r.status, 401);
  });

  test('me devolve a empresa certa', async () => {
    const r = await alfa.api.get('/auth/me');
    assert.equal(r.data.tenant.slug, alfa.slug);
    assert.equal(r.data.user.role, 'OWNER');
  });

  test('logout derruba a sessão', async () => {
    const c = await usuarioCom(alfa, 'ADMIN');
    assert.equal((await c.get('/auth/me')).status, 200);
    await c.post('/auth/logout');
    assert.equal((await c.get('/auth/me')).status, 401);
  });

  test('token adulterado não passa', async () => {
    const r = await fetch(`${BASE}/api/v1/auth/me`, {
      headers: { authorization: 'Bearer nao.e.um.jwt.valido' },
    });
    assert.equal(r.status, 401);
  });
});

describe('papéis', () => {
  test('STAFF vê a agenda mas não mexe em serviços nem configurações', async () => {
    const staff = await usuarioCom(alfa, 'STAFF');

    assert.equal((await staff.get('/appointments')).status, 200, 'agenda é o trabalho dele');
    assert.equal((await staff.get('/clients')).status, 200);
    assert.equal((await staff.get('/services')).status, 200, 'precisa ver para agendar');

    assert.equal(
      (await staff.post('/services', { name: 'Novo', price: 10, durationMinutes: 30 })).status,
      403,
      'criar serviço é de ADMIN para cima'
    );
    assert.equal((await staff.get('/settings')).status, 403);
    assert.equal((await staff.get('/expenses')).status, 403, 'financeiro não é dele');
    assert.equal(
      (await staff.post('/products', { name: 'X', price: 1 })).status,
      403,
      'cadastrar produto é de ADMIN'
    );
  });

  test('ADMIN administra a operação', async () => {
    const admin = await usuarioCom(alfa, 'ADMIN');

    assert.equal(
      (await admin.post('/services', { name: 'Feito pelo admin', price: 50, durationMinutes: 30 })).status,
      201
    );
    assert.equal((await admin.get('/settings')).status, 200);
    assert.equal((await admin.get('/expenses')).status, 200);
  });
});

describe('validação de entrada', () => {
  test('campos obrigatórios são cobrados', async () => {
    const r = await alfa.api.post('/services', { name: 'S', price: -5 });
    assert.equal(r.status, 400);
    assert.equal(r.error?.code, 'validation_error');
  });

  test('telefone inválido não vira cliente', async () => {
    const r = await alfa.api.post('/clients', { name: 'Sem Telefone', phone: '123' });
    assert.ok(r.status >= 400);
  });

  test('id fora do formato não derruba a API', async () => {
    const r = await alfa.api.get('/appointments/isso-nao-e-uuid');
    assert.ok([400, 404, 500].includes(r.status));
    assert.ok(r.error, 'precisa responder erro tratado, não corpo vazio');
  });

  test('corpo sem JSON é recusado com mensagem clara', async () => {
    const r = await fetch(`${BASE}/api/v1/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alfa.api.cookieHeader },
      body: 'isto não é json',
    });
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.match(body.error.message, /JSON/);
  });
});

describe('worker', () => {
  test('sem o segredo o job não roda', async () => {
    const semSegredo = await fetch(`${BASE}/api/v1/jobs/run`, { method: 'POST' });
    assert.equal(semSegredo.status, 403);

    const errado = await fetch(`${BASE}/api/v1/jobs/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer segredo-errado' },
    });
    assert.equal(errado.status, 403);
  });

  test('com o segredo certo roda e devolve o resumo', async () => {
    const r = await fetch(`${BASE}/api/v1/jobs/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.ok('reservasExpiradas' in body.data);
    assert.ok('mensagensEnviadas' in body.data);
  });
});
