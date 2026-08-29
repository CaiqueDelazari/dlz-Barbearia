/**
 * O que o dono olha: dinheiro que entrou, dinheiro que saiu, ficha do cliente
 * e as mensagens que o sistema promete mandar.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { query } from '@/lib/db';
import {
  agendarPeloPainel, ajustarConfig, criarEmpresa, criarServico, diaUtil, dinheiro,
  fecharPool, horarios, hojeLocal, type Empresa,
} from '../helpers/e2e';

let empresa: Empresa;
let corte: { id: string; price: number; durationMinutes: number };

let proximo = 70;
// passo 4: `diaUtil` empurra fim de semana para a segunda, e com passo 2 dois
// offsets vizinhos caem no mesmo dia sempre que o primeiro cai no sábado
const diaExclusivo = () => diaUtil((proximo += 4));

async function atendimento(nome: string, telefone = '11944445555') {
  const dia = diaExclusivo();
  const { slots } = await horarios(empresa, dia, [corte.id]);
  const criado = await agendarPeloPainel(empresa, {
    startsAt: slots[0].startsAt, serviceIds: [corte.id], professionalId: slots[0].professionalId,
    nome, telefone,
  });
  return { id: criado.appointments[0].id, dia };
}

/**
 * Traz o atendimento para hoje — dashboard e relatórios olham a data da agenda.
 *
 * Cada chamada usa uma faixa própria: mover dois para o mesmo horário esbarra
 * na trava do banco contra sobreposição (e é bom que esbarre).
 */
let faixaDoDia = 0;
async function trazerParaHoje(appointmentId: string) {
  const inicio = faixaDoDia;
  faixaDoDia += 45;

  await query(
    `UPDATE appointments
        SET starts_at = (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                          + make_interval(hours => 8, mins => $2)) AT TIME ZONE 'America/Sao_Paulo',
            ends_at   = (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                          + make_interval(hours => 8, mins => $3)) AT TIME ZONE 'America/Sao_Paulo'
      WHERE id = $1`,
    [appointmentId, inicio, inicio + 30]
  );
}

before(async () => {
  empresa = await criarEmpresa('financeiro');
  await ajustarConfig(empresa, { onlinePaymentRequired: false, minAdvanceMinutes: 0 });
  corte = await criarServico(empresa, { name: 'Corte', price: 150, durationMinutes: 60 });
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('despesas', () => {
  test('lança, aparece na lista e soma no total', async () => {
    const hoje = hojeLocal();
    const r = await empresa.api.post('/expenses', {
      description: 'Compra de coloração', category: 'Produtos', amount: 340.5,
      date: hoje, paymentMethod: 'pix',
    });
    assert.equal(r.status, 201);

    const lista = await empresa.api.get(`/expenses?from=${hoje}&to=${hoje}`);
    assert.ok(lista.data.expenses.some((e: any) => e.description === 'Compra de coloração'));
    assert.equal(dinheiro(lista.data.total), 340.5);
  });

  test('some da lista quando removida', async () => {
    const hoje = hojeLocal();
    const criada = await empresa.api.post('/expenses', {
      description: 'Lançada errada', amount: 99, date: hoje,
    });
    const del = await empresa.api.del(`/expenses/${criada.data.expense.id}`);
    assert.equal(del.status, 200);

    const lista = await empresa.api.get(`/expenses?from=${hoje}&to=${hoje}`);
    assert.ok(!lista.data.expenses.some((e: any) => e.description === 'Lançada errada'));
  });

  test('valor zero ou negativo é recusado', async () => {
    const hoje = hojeLocal();
    assert.equal((await empresa.api.post('/expenses', { description: 'X', amount: 0, date: hoje })).status, 400);
    assert.equal((await empresa.api.post('/expenses', { description: 'X', amount: -10, date: hoje })).status, 400);
  });

  test('filtro por período não traz o que está fora', async () => {
    const antigo = '2020-01-15';
    await empresa.api.post('/expenses', { description: 'Antiga', amount: 10, date: antigo });

    const hoje = hojeLocal();
    const doMes = await empresa.api.get(`/expenses?from=${hoje}&to=${hoje}`);
    assert.ok(!doMes.data.expenses.some((e: any) => e.description === 'Antiga'));

    const doPassado = await empresa.api.get(`/expenses?from=2020-01-01&to=2020-01-31`);
    assert.ok(doPassado.data.expenses.some((e: any) => e.description === 'Antiga'));
  });
});

describe('dashboard', () => {
  test('conta atendimento, recebido e pendente do dia', async () => {
    const a = await atendimento('Pagou Metade');
    await trazerParaHoje(a.id);
    await empresa.api.post(`/appointments/${a.id}/payments`, { amount: 50, method: 'cash' });

    const d = await empresa.api.get('/dashboard?range=today');
    assert.equal(d.status, 200);
    assert.ok(d.data.cards.agendamentosHoje >= 1);
    assert.ok(dinheiro(d.data.cards.recebido) >= 50);
    assert.ok(dinheiro(d.data.cards.pendente) >= 100, 'os R$ 100 que faltam aparecem');
  });

  test('resultado é o recebido menos as despesas', async () => {
    const d = await empresa.api.get('/dashboard?range=today');
    const { recebido, despesas, resultado } = d.data.cards;
    assert.equal(dinheiro(resultado), dinheiro(recebido - despesas));
  });

  test('traz as despesas recentes e o estoque baixo', async () => {
    await empresa.api.post('/products', {
      name: 'Quase acabando', price: 50, stockQuantity: 0, minStock: 2,
    });

    const d = await empresa.api.get('/dashboard?range=today');
    assert.ok(Array.isArray(d.data.despesasRecentes));
    assert.ok(d.data.despesasRecentes.length >= 1, 'as últimas despesas aparecem na tela');
    assert.ok(d.data.estoqueBaixo.some((p: any) => p.name === 'Quase acabando'));
  });

  test('conta os concluídos e as faltas separadamente', async () => {
    const concluido = await atendimento('Compareceu');
    const faltou = await atendimento('Não veio');
    await trazerParaHoje(concluido.id);
    await trazerParaHoje(faltou.id);

    await empresa.api.patch(`/appointments/${concluido.id}`, { status: 'completed' });
    await empresa.api.patch(`/appointments/${faltou.id}`, { status: 'no_show' });

    const d = await empresa.api.get('/dashboard?range=today');
    assert.ok(d.data.cards.concluidos >= 1);
    assert.ok(d.data.cards.faltas >= 1);
  });

  test('falta aumenta o contador do cliente', async () => {
    const clientes = await empresa.api.get('/clients?search=Não veio');
    const cliente = clientes.data.items[0];
    const ficha = await empresa.api.get(`/clients/${cliente.id}`);
    assert.ok(ficha.data.summary.no_shows >= 1);
  });

  test('período personalizado respeita as datas', async () => {
    const r = await empresa.api.get('/dashboard?range=custom&from=2020-01-01&to=2020-01-31');
    assert.equal(r.status, 200);
    assert.equal(r.data.cards.agendamentosPeriodo, 0, 'nada em 2020');
    assert.equal(dinheiro(r.data.cards.despesas), 10, 'só a despesa antiga');
  });
});

describe('resumo financeiro', () => {
  test('separa entradas por forma de pagamento', async () => {
    const a = await atendimento('Pagou no Pix');
    await empresa.api.post(`/appointments/${a.id}/payments`, { amount: 150, method: 'pix' });

    const r = await empresa.api.get('/financial/summary?range=month');
    assert.equal(r.status, 200);
    const pix = r.data.pagamentosPorMetodo.find((m: any) => m.metodo === 'pix');
    assert.ok(pix, 'precisa listar o Pix');
    assert.ok(dinheiro(pix.total) >= 150);
  });

  test('separa despesas por categoria', async () => {
    const r = await empresa.api.get('/financial/summary?range=month');
    const produtos = r.data.despesasPorCategoria.find((c: any) => c.categoria === 'Produtos');
    assert.ok(produtos, 'a categoria lançada aparece');
    assert.ok(dinheiro(produtos.total) >= 340.5);
  });

  test('resultado bate com entradas menos despesas', async () => {
    const r = await empresa.api.get('/financial/summary?range=month');
    assert.equal(dinheiro(r.data.resultado), dinheiro(r.data.entradas - r.data.despesas));
  });

  test('quebra os produtos vendidos', async () => {
    const produto = await empresa.api.post('/products', {
      name: 'Máscara vendida', price: 200, stockQuantity: 5,
    });
    const a = await atendimento('Levou Produto');
    await trazerParaHoje(a.id);
    await empresa.api.post(`/appointments/${a.id}/products`, {
      productId: produto.data.product.id, quantity: 1,
    });

    const r = await empresa.api.get('/financial/summary?range=today');
    const linha = r.data.produtosVendidos.find((p: any) => p.produto === 'Máscara vendida');
    assert.ok(linha, 'o produto aparece na quebra');
    assert.equal(dinheiro(linha.total), 200);
  });
});

describe('ficha do cliente', () => {
  test('junta histórico, total gasto e serviços mais usados', async () => {
    const a = await atendimento('Cliente Fiel', '11933334444');
    await trazerParaHoje(a.id);
    await empresa.api.post(`/appointments/${a.id}/payments`, { amount: 150, method: 'card' });
    await empresa.api.patch(`/appointments/${a.id}`, { status: 'completed' });

    const lista = await empresa.api.get('/clients?search=Cliente Fiel');
    const cliente = lista.data.items[0];
    assert.ok(cliente, 'o cliente foi criado junto com o agendamento');

    const ficha = await empresa.api.get(`/clients/${cliente.id}`);
    assert.equal(ficha.status, 200);
    assert.equal(ficha.data.summary.total_appointments, 1);
    assert.equal(dinheiro(ficha.data.summary.total_spent), 150);
    assert.ok(ficha.data.services.some((s: any) => s.name === 'Corte'));
    assert.ok(ficha.data.appointments.length >= 1);
  });

  test('busca por telefone encontra', async () => {
    const r = await empresa.api.get('/clients?search=11933334444');
    assert.ok(r.data.items.some((c: any) => c.name === 'Cliente Fiel'));
  });

  test('bloquear cliente impede novo agendamento', async () => {
    const lista = await empresa.api.get('/clients?search=Cliente Fiel');
    const cliente = lista.data.items[0];
    await empresa.api.patch(`/clients/${cliente.id}`, { blocked: true });

    const dia = diaExclusivo();
    const { slots } = await horarios(empresa, dia, [corte.id]);
    const r = await empresa.api.post('/appointments', {
      items: [{ startsAt: slots[0].startsAt, serviceIds: [corte.id] }],
      client: { name: 'Cliente Fiel', phone: '11933334444' },
    });
    assert.equal(r.status, 403);

    await empresa.api.patch(`/clients/${cliente.id}`, { blocked: false });
  });

  test('mesmo telefone não vira dois cadastros', async () => {
    const antes = await empresa.api.get('/clients?search=11933334444');
    await atendimento('Cliente Fiel', '11933334444');
    const depois = await empresa.api.get('/clients?search=11933334444');
    assert.equal(depois.data.total, antes.data.total, 'reaproveita o cadastro');
  });
});

describe('notificações', () => {
  test('confirmação entra na fila ao agendar', async () => {
    const a = await atendimento('Recebe Aviso', '11922223333');

    const fila = await query(
      `SELECT type, status FROM notifications WHERE tenant_id = $1 AND appointment_id = $2`,
      [empresa.tenantId, a.id]
    );
    const tipos = fila.map((n: any) => n.type);
    assert.ok(tipos.includes('confirmation'), 'a confirmação é agendada');
    assert.ok(tipos.includes('reminder_24h'), 'o lembrete de 24h também');
  });

  test('cancelar derruba os avisos pendentes', async () => {
    const a = await atendimento('Vai Cancelar', '11922224444');
    await empresa.api.patch(`/appointments/${a.id}`, { status: 'cancelled' });

    const fila = await query(
      `SELECT status FROM notifications WHERE tenant_id = $1 AND appointment_id = $2`,
      [empresa.tenantId, a.id]
    );
    assert.ok(
      fila.every((n: any) => n.status !== 'scheduled'),
      'ninguém recebe lembrete de horário cancelado'
    );
  });

  test('remarcar reprograma os lembretes para o novo horário', async () => {
    const a = await atendimento('Vai Remarcar', '11922225555');
    const novoDia = diaExclusivo();
    const { slots } = await horarios(empresa, novoDia, [corte.id]);

    await empresa.api.patch(`/appointments/${a.id}`, { startsAt: slots[0].startsAt });

    const ativos = await query(
      `SELECT scheduled_for FROM notifications
        WHERE tenant_id = $1 AND appointment_id = $2 AND status = 'scheduled' AND type = 'reminder_24h'`,
      [empresa.tenantId, a.id]
    );
    assert.equal(ativos.length, 1, 'um único lembrete de 24h, o do horário novo');
    const esperado = new Date(new Date(slots[0].startsAt).getTime() - 24 * 3_600_000);
    assert.equal(
      new Date(ativos[0].scheduled_for).toISOString().slice(0, 16),
      esperado.toISOString().slice(0, 16)
    );
  });

  test('modelos de mensagem vêm com padrão e aceitam edição', async () => {
    const r = await empresa.api.get('/notifications/templates');
    assert.equal(r.status, 200);
    assert.ok(r.data.templates.length >= 6);
    assert.ok(r.data.variaveis.includes('cliente'));

    const salvo = await empresa.api.patch('/notifications/templates', {
      templates: [{ key: 'reminder_1h', body: 'Oi {cliente}, é daqui a pouco!', enabled: true }],
    });
    assert.equal(salvo.status, 200);

    const depois = await empresa.api.get('/notifications/templates');
    const editado = depois.data.templates.find((t: any) => t.key === 'reminder_1h');
    assert.match(editado.body, /daqui a pouco/);
  });

  test('envio avulso entra na fila', async () => {
    const r = await empresa.api.post('/notifications/send', {
      phone: '11922226666', message: 'Chegou a coloração que você pediu',
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.queued, true);

    const fila = await empresa.api.get('/notifications/send');
    assert.ok(fila.data.notifications.some((n: any) => n.type === 'manual'));
  });

  test('worker marca como skipped quando o WhatsApp está desligado', async () => {
    const r = await fetch(`${process.env.APP_URL}/api/v1/jobs/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }).then((x) => x.json());

    assert.ok(r.data.mensagensEnviadas >= 0);
    const fila = await query(
      `SELECT status FROM notifications WHERE tenant_id = $1 AND status = 'skipped' LIMIT 1`,
      [empresa.tenantId]
    );
    assert.equal(fila.length, 1, 'sem gateway configurado, a mensagem fica marcada e não some');
  });
});

describe('relatórios', () => {
  test('agrupa por dia e por serviço', async () => {
    const r = await empresa.api.get(`/dashboard?range=custom&from=${hojeLocal()}&to=${hojeLocal()}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.porDia));
    assert.ok(r.data.servicos.some((s: any) => s.name === 'Corte'));
  });

  test('ticket médio usa os concluídos', async () => {
    const r = await empresa.api.get('/dashboard?range=today');
    const { concluidos, recebido, ticketMedio } = r.data.cards;
    if (concluidos > 0) {
      assert.equal(dinheiro(ticketMedio), dinheiro(recebido / concluidos));
    }
  });
});
