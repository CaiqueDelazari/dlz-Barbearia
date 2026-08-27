/**
 * Fluxo do cliente: escolher serviços, ver horários reais, agendar, e as
 * garantias que sustentam tudo — duração combinada e nada de double booking.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import {
  agendarPeloPainel, ajustarConfig, criarEmpresa, criarServico, diaUtil, dinheiro,
  fecharPool, horarios, listarProfissionais, mesDe, type Empresa,
} from '../helpers/e2e';

let empresa: Empresa;
let corte: { id: string; price: number; durationMinutes: number };
let escova: { id: string; price: number; durationMinutes: number };
let sobrancelha: { id: string; price: number; durationMinutes: number };
const dia = diaUtil(10);

before(async () => {
  empresa = await criarEmpresa('agendamento');
  // sem pagamento online os testes olham direto para a regra da agenda
  await ajustarConfig(empresa, { onlinePaymentRequired: false, minAdvanceMinutes: 0 });

  corte = await criarServico(empresa, { name: 'Corte', price: 120, durationMinutes: 60, category: 'Cabelo' });
  escova = await criarServico(empresa, { name: 'Escova', price: 80, durationMinutes: 45, category: 'Cabelo' });
  sobrancelha = await criarServico(empresa, {
    name: 'Sobrancelha', price: 50, durationMinutes: 30, category: 'Estética',
  });
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('página pública', () => {
  test('devolve empresa, serviços e categorias', async () => {
    const pagina = await empresa.anon.get(`/public/${empresa.slug}`);
    assert.equal(pagina.status, 200);
    assert.equal(pagina.data.tenant.slug, empresa.slug);
    assert.ok(pagina.data.booking.depositPercent > 0);

    const servicos = await empresa.anon.get(`/public/${empresa.slug}/services`);
    assert.equal(servicos.data.services.length, 3);
    const categorias = new Set(servicos.data.services.map((s: any) => s.category));
    assert.deepEqual([...categorias].sort(), ['Cabelo', 'Estética']);
  });

  test('empresa inexistente devolve 404 sem vazar nada', async () => {
    const r = await empresa.anon.get('/public/nao-existe-mesmo/services');
    assert.equal(r.status, 404);
    assert.equal(r.data, undefined);
  });
});

describe('disponibilidade', () => {
  test('respeita expediente e almoço', async () => {
    const { slots } = await horarios(empresa, dia, [sobrancelha.id]);
    const horas = slots.map((s) => s.time);

    assert.equal(horas[0], '09:00', 'abre às 09:00');
    assert.ok(!horas.includes('12:00'), 'almoço não aparece');
    assert.ok(!horas.includes('12:30'), 'almoço não aparece');
    assert.ok(horas.includes('13:00'), 'volta às 13:00');
    assert.equal(horas.at(-1), '18:30', 'último encaixe de 30min termina às 19:00');
  });

  test('soma preço e duração da combinação', async () => {
    const r = await horarios(empresa, dia, [corte.id, escova.id]);
    assert.equal(r.totalDurationMinutes, 105);
    assert.equal(dinheiro(r.totalAmount), 200);
    assert.equal(r.fitsTogether, true);
  });

  test('serviço longo tem menos encaixes que serviço curto', async () => {
    const curto = await horarios(empresa, dia, [sobrancelha.id]);
    const longo = await horarios(empresa, dia, [corte.id, escova.id]);
    assert.ok(longo.slots.length < curto.slots.length);
    // 105 min não cabe entre 11:30 e o almoço das 12:00
    assert.ok(!longo.slots.some((s) => s.time === '11:30'));
  });

  test('calendário do mês marca só dias com vaga', async () => {
    const r = await empresa.anon.get(
      `/public/${empresa.slug}/availability?month=${mesDe(dia)}&services=${corte.id}`
    );
    assert.equal(r.status, 200);
    const domingos = r.data.days.filter((d: any) => new Date(`${d.date}T12:00:00`).getDay() === 0);
    assert.ok(domingos.every((d: any) => !d.available), 'domingo fechado nunca fica disponível');
    assert.ok(r.data.days.some((d: any) => d.available), 'existe pelo menos um dia livre');
  });

  test('data no passado não tem horário', async () => {
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const passado = ontem.toISOString().slice(0, 10);
    const { slots } = await horarios(empresa, passado, [corte.id]);
    assert.equal(slots.length, 0);
  });
});

describe('agendamento', () => {
  test('ocupa o bloco inteiro da combinação', async () => {
    const antes = await horarios(empresa, dia, [corte.id, escova.id]);
    const alvo = antes.slots.find((s) => s.time === '14:00')!;
    assert.ok(alvo, 'esperava 14:00 livre');

    const criado = await agendarPeloPainel(empresa, {
      startsAt: alvo.startsAt,
      serviceIds: [corte.id, escova.id],
      professionalId: alvo.professionalId,
      nome: 'Bloco Cheio',
    });
    assert.equal(dinheiro(criado.totalAmount), 200);

    const depois = await horarios(empresa, dia, [sobrancelha.id], alvo.professionalId ?? undefined);
    const horas = depois.slots.map((s) => s.time);
    // 14:00 -> 15:45 fica todo indisponível, inclusive as frações do meio
    for (const h of ['14:00', '14:30', '15:00', '15:30']) {
      assert.ok(!horas.includes(h), `${h} deveria estar ocupado`);
    }
    assert.ok(horas.includes('16:00'), '16:00 segue livre');
  });

  test('recusa o mesmo horário duas vezes', async () => {
    const { slots } = await horarios(empresa, dia, [sobrancelha.id]);
    const alvo = slots[0];

    await agendarPeloPainel(empresa, {
      startsAt: alvo.startsAt, serviceIds: [sobrancelha.id], professionalId: alvo.professionalId,
    });

    const segundo = await empresa.api.post('/appointments', {
      items: [{ startsAt: alvo.startsAt, serviceIds: [sobrancelha.id], professionalId: alvo.professionalId }],
      client: { name: 'Segundo', phone: '11977776666' },
    });
    assert.equal(segundo.status, 409);
    assert.equal(segundo.error?.code, 'slot_taken');
  });

  test('cinco pedidos simultâneos criam um só agendamento', async () => {
    const { slots } = await horarios(empresa, dia, [sobrancelha.id]);
    const alvo = slots.at(-1)!;

    const respostas = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        empresa.api.post('/appointments', {
          items: [{ startsAt: alvo.startsAt, serviceIds: [sobrancelha.id], professionalId: alvo.professionalId }],
          client: { name: `Corrida ${i}`, phone: `1190000000${i}` },
        })
      )
    );

    const criados = respostas.filter((r) => r.status === 201);
    const barrados = respostas.filter((r) => r.status === 409);
    assert.equal(criados.length, 1, 'só um pode passar');
    assert.equal(barrados.length, 4);
  });

  test('horário fora do expediente é recusado', async () => {
    const r = await empresa.api.post('/appointments', {
      items: [{ startsAt: `${dia}T05:00:00.000Z`, serviceIds: [corte.id] }],
      client: { name: 'Madrugada', phone: '11955554444' },
    });
    assert.ok(r.status >= 400, 'não pode aceitar horário fora da agenda');
  });

  test('serviço inexistente é recusado', async () => {
    const { slots } = await horarios(empresa, diaUtil(20), [corte.id]);
    const r = await empresa.api.post('/appointments', {
      items: [{ startsAt: slots[0].startsAt, serviceIds: ['00000000-0000-0000-0000-000000000000'] }],
      client: { name: 'Fantasma', phone: '11944443333' },
    });
    assert.equal(r.status, 400);
  });
});

describe('vários profissionais', () => {
  test('cada profissional tem a própria agenda e seus serviços', async () => {
    const outroDia = diaUtil(15);
    const larissa = await criarProfissionalComSobrancelha();

    // sobrancelha vinculada só à Larissa: some para os outros
    const soDela = await horarios(empresa, outroDia, [sobrancelha.id]);
    assert.ok(soDela.slots.length > 0);
    assert.ok(
      soDela.slots.every((s) => s.professionalId === larissa.id),
      'sobrancelha só pode cair na Larissa'
    );

    // ocupar a Larissa não derruba o horário do outro profissional
    const profissionais = await listarProfissionais(empresa);
    const outra = profissionais.find((p) => p.id !== larissa.id)!;

    const alvo = soDela.slots.find((s) => s.time === '10:00')!;
    await agendarPeloPainel(empresa, {
      startsAt: alvo.startsAt, serviceIds: [sobrancelha.id], professionalId: larissa.id, nome: 'Cliente Larissa',
    });

    const daLarissa = await horarios(empresa, outroDia, [corte.id], larissa.id);
    const daOutra = await horarios(empresa, outroDia, [corte.id], outra.id);
    assert.ok(!daLarissa.slots.some((s) => s.time === '10:00'), 'Larissa ocupada às 10:00');
    assert.ok(daOutra.slots.some((s) => s.time === '10:00'), 'a outra segue livre às 10:00');
  });
});

async function criarProfissionalComSobrancelha() {
  const { criarProfissional } = await import('../helpers/e2e');
  return criarProfissional(empresa, 'Larissa', [sobrancelha.id]);
}
