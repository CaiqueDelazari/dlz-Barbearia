/**
 * Fechar a agenda: bloqueio pontual, período de férias, folga de um
 * profissional, pausa fixa semanal — e a regra que protege quem já está
 * marcado.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import {
  agendarPeloPainel, ajustarConfig, criarEmpresa, criarProfissional, criarServico, diaUtil,
  fecharPool, horarios, listarProfissionais, type Empresa,
} from '../helpers/e2e';

let empresa: Empresa;
let corte: { id: string; price: number; durationMinutes: number };
let dona: { id: string; name: string };
let larissa: { id: string; name: string };

/**
 * Cada teste usa um dia próprio para não disputar horário com o vizinho.
 *
 * O passo é 4 e não 2 de propósito: `diaUtil` empurra fim de semana para a
 * segunda, então dois offsets separados por 2 dias caem no MESMO dia sempre que
 * o primeiro cai no sábado — e aí um teste bloqueia a agenda do outro. Com 4
 * dias de intervalo o empurrão nunca alcança o vizinho.
 */
let proximo = 20;
const diaExclusivo = () => diaUtil((proximo += 4));

const horas = (slots: { time: string }[]) => slots.map((s) => s.time);

before(async () => {
  empresa = await criarEmpresa('fechar');
  await ajustarConfig(empresa, { onlinePaymentRequired: false, minAdvanceMinutes: 0 });
  corte = await criarServico(empresa, { name: 'Corte', price: 100, durationMinutes: 30 });

  larissa = await criarProfissional(empresa, 'Larissa');
  dona = (await listarProfissionais(empresa)).find((p) => p.id !== larissa.id)!;
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('bloqueio pontual', () => {
  test('fecha a tarde e some da agenda pública', async () => {
    const dia = diaExclusivo();
    const antes = await horarios(empresa, dia, [corte.id]);
    assert.ok(horas(antes.slots).includes('15:00'));

    const r = await empresa.api.post('/blocks', {
      date: dia, startTime: '14:00', endTime: '19:00', reason: 'Curso', kind: 'block',
    });
    assert.equal(r.status, 201, JSON.stringify(r.error));

    const depois = await horarios(empresa, dia, [corte.id]);
    assert.ok(!horas(depois.slots).some((h) => h >= '14:00'), 'nada depois das 14:00');
    assert.ok(horas(depois.slots).includes('09:00'), 'a manhã segue aberta');
  });

  test('reabrir devolve os horários', async () => {
    const dia = diaExclusivo();
    const antes = await horarios(empresa, dia, [corte.id]);

    const bloqueio = await empresa.api.post('/blocks', {
      date: dia, startTime: '09:00', endTime: '12:00', reason: 'Dentista',
    });
    const fechado = await horarios(empresa, dia, [corte.id]);
    assert.ok(fechado.slots.length < antes.slots.length);

    const del = await empresa.api.del(`/blocks/${bloqueio.data.block.id}`);
    assert.equal(del.status, 200);

    const reaberto = await horarios(empresa, dia, [corte.id]);
    assert.equal(reaberto.slots.length, antes.slots.length, 'voltou ao que era');
  });

  test('dia inteiro zera a agenda daquele dia', async () => {
    const dia = diaExclusivo();
    await empresa.api.post('/blocks', { date: dia, reason: 'Feriado', kind: 'holiday' });

    const depois = await horarios(empresa, dia, [corte.id]);
    assert.equal(depois.slots.length, 0);
  });

  test('período de férias fecha todos os dias do intervalo', async () => {
    const inicio = diaExclusivo();
    const fim = diaUtil(proximo + 4);

    await empresa.api.post('/blocks', {
      date: inicio, endDate: fim, reason: 'Férias', kind: 'vacation',
    });

    for (const dia of [inicio, fim]) {
      const r = await horarios(empresa, dia, [corte.id]);
      assert.equal(r.slots.length, 0, `${dia} deveria estar fechado`);
    }
  });

  test('data final antes da inicial é recusada', async () => {
    const dia = diaExclusivo();
    const r = await empresa.api.post('/blocks', { date: dia, endDate: diaUtil(1) });
    assert.equal(r.status, 400);
  });

  test('horário final menor que o inicial é recusado', async () => {
    const dia = diaExclusivo();
    const r = await empresa.api.post('/blocks', { date: dia, startTime: '15:00', endTime: '10:00' });
    assert.equal(r.status, 400);
  });
});

describe('bloqueio por profissional', () => {
  test('fechar para uma não fecha para a outra', async () => {
    const dia = diaExclusivo();

    await empresa.api.post('/blocks', {
      date: dia, startTime: '09:00', endTime: '19:00', professionalId: larissa.id,
      reason: 'Folga', kind: 'dayoff',
    });

    const daLarissa = await horarios(empresa, dia, [corte.id], larissa.id);
    const daDona = await horarios(empresa, dia, [corte.id], dona.id);

    assert.equal(daLarissa.slots.length, 0, 'Larissa fechada');
    assert.ok(daDona.slots.length > 0, 'a outra segue atendendo');
  });

  test('bloqueio da empresa fecha para todo mundo', async () => {
    const dia = diaExclusivo();
    await empresa.api.post('/blocks', { date: dia, reason: 'Reforma' });

    for (const prof of [larissa.id, dona.id]) {
      const r = await horarios(empresa, dia, [corte.id], prof);
      assert.equal(r.slots.length, 0);
    }
  });
});

describe('cliente já marcado', () => {
  test('recusa o bloqueio e devolve quem está na agenda', async () => {
    const dia = diaExclusivo();
    const { slots } = await horarios(empresa, dia, [corte.id]);
    const alvo = slots.find((s) => s.time === '10:00')!;

    await agendarPeloPainel(empresa, {
      startsAt: alvo.startsAt, serviceIds: [corte.id], professionalId: alvo.professionalId,
      nome: 'Cliente Marcado', telefone: '11966665555',
    });

    const r = await empresa.api.post('/blocks', {
      date: dia, startTime: '09:00', endTime: '12:00', reason: 'Imprevisto', onConflict: 'abort',
    });

    assert.equal(r.status, 409);
    assert.equal(r.error?.code, 'has_appointments');
    const lista = r.error!.details.appointments;
    assert.equal(lista.length, 1);
    assert.equal(lista[0].clientName, 'Cliente Marcado');
    assert.equal(lista[0].time, '10:00');
    assert.ok(lista[0].clientPhone, 'precisa do telefone para avisar');
  });

  test('manter: fecha para novos e preserva quem já tinha', async () => {
    const dia = diaExclusivo();
    const { slots } = await horarios(empresa, dia, [corte.id]);
    const alvo = slots.find((s) => s.time === '10:00')!;
    const criado = await agendarPeloPainel(empresa, {
      startsAt: alvo.startsAt, serviceIds: [corte.id], professionalId: alvo.professionalId,
      nome: 'Fica na Agenda', telefone: '11966665554',
    });

    const r = await empresa.api.post('/blocks', {
      date: dia, reason: 'Feriado', kind: 'holiday', onConflict: 'keep',
    });

    assert.equal(r.status, 201);
    assert.equal(r.data.keptAppointments, 1);
    assert.equal(r.data.cancelledAppointments, 0);

    const publico = await horarios(empresa, dia, [corte.id]);
    assert.equal(publico.slots.length, 0, 'nenhuma vaga nova');

    const appt = await empresa.api.get(`/appointments/${criado.appointments[0].id}`);
    assert.equal(appt.data.appointment.status, 'confirmed', 'o cliente segue marcado');
  });

  test('cancelar: derruba os agendamentos e fecha', async () => {
    const dia = diaExclusivo();
    const { slots } = await horarios(empresa, dia, [corte.id]);
    const criado = await agendarPeloPainel(empresa, {
      startsAt: slots[0].startsAt, serviceIds: [corte.id], professionalId: slots[0].professionalId,
      nome: 'Vai Ser Cancelado', telefone: '11966665553',
    });

    const r = await empresa.api.post('/blocks', {
      date: dia, reason: 'Emergência', onConflict: 'cancel',
    });

    assert.equal(r.status, 201);
    assert.equal(r.data.cancelledAppointments, 1);

    const appt = await empresa.api.get(`/appointments/${criado.appointments[0].id}`);
    assert.equal(appt.data.appointment.status, 'cancelled');
    assert.match(appt.data.appointment.cancelled_reason, /Emergência/);
  });
});

describe('pausa fixa semanal', () => {
  test('repete no mesmo dia da semana e vale só para o profissional', async () => {
    const dia = diaExclusivo();
    const semanaSeguinte = new Date(`${dia}T12:00:00`);
    semanaSeguinte.setDate(semanaSeguinte.getDate() + 7);
    const d7 = semanaSeguinte.toISOString().slice(0, 10);

    const r = await empresa.api.post('/blocks', {
      date: dia, startTime: '09:00', endTime: '11:00', professionalId: larissa.id,
      reason: 'Faculdade', repeatWeekly: true,
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.repeated, true);

    for (const d of [dia, d7]) {
      const dela = await horarios(empresa, d, [corte.id], larissa.id);
      assert.ok(
        !horas(dela.slots).some((h) => h >= '09:00' && h < '11:00'),
        `${d}: manhã da Larissa fechada`
      );
    }

    const daDona = await horarios(empresa, d7, [corte.id], dona.id);
    assert.ok(horas(daDona.slots).includes('09:00'), 'a pausa é só dela');

    const del = await empresa.api.del(`/blocks/${r.data.weeklyBreak.id}?type=weekly`);
    assert.equal(del.status, 200);

    const voltou = await horarios(empresa, d7, [corte.id], larissa.id);
    assert.ok(horas(voltou.slots).includes('09:00'), 'removida a pausa, volta a atender');
  });

  test('pausa pessoal não apaga o almoço da empresa', async () => {
    const dia = diaExclusivo();
    const r = await empresa.api.post('/blocks', {
      date: dia, startTime: '09:00', endTime: '10:00', professionalId: larissa.id,
      reason: 'Pessoal', repeatWeekly: true,
    });

    const dela = await horarios(empresa, dia, [corte.id], larissa.id);
    assert.ok(!horas(dela.slots).includes('09:00'), 'pausa pessoal vale');
    assert.ok(!horas(dela.slots).includes('12:00'), 'almoço da casa continua valendo');
    assert.ok(horas(dela.slots).includes('13:00'), 'depois do almoço reabre');

    await empresa.api.del(`/blocks/${r.data.weeklyBreak.id}?type=weekly`);
  });

  test('pausa fixa de dia inteiro é recusada com explicação', async () => {
    const r = await empresa.api.post('/blocks', { date: diaExclusivo(), repeatWeekly: true });
    assert.equal(r.status, 400);
    assert.equal(r.error?.code, 'weekly_needs_time');
    assert.match(r.error!.message, /Configurações/);
  });
});

describe('agenda do painel', () => {
  test('mostra atendimentos, bloqueios, pausas e expediente', async () => {
    const dia = diaExclusivo();
    const { slots } = await horarios(empresa, dia, [corte.id]);
    await agendarPeloPainel(empresa, {
      startsAt: slots[0].startsAt, serviceIds: [corte.id], professionalId: slots[0].professionalId,
      nome: 'Na Agenda', telefone: '11955554444',
    });
    await empresa.api.post('/blocks', {
      date: dia, startTime: '16:00', endTime: '17:00', reason: 'Fornecedor', onConflict: 'keep',
    });

    const agenda = await empresa.api.get(`/agenda?date=${dia}&view=day`);
    assert.equal(agenda.status, 200);
    assert.equal(agenda.data.items.length, 1, 'o atendimento aparece');
    assert.ok(agenda.data.blocks.length >= 1, 'o bloqueio aparece');
    assert.ok(agenda.data.weeklyBreaks.length >= 1, 'o almoço aparece');
    assert.ok(agenda.data.hours.length >= 1, 'o expediente aparece');
  });

  test('visão de semana cobre sete dias', async () => {
    const agenda = await empresa.api.get(`/agenda?date=${diaExclusivo()}&view=week`);
    assert.equal(agenda.status, 200);
    const dias =
      (new Date(`${agenda.data.to}T12:00:00`).getTime() -
        new Date(`${agenda.data.from}T12:00:00`).getTime()) /
      86_400_000;
    assert.equal(Math.round(dias), 6, 'de domingo a sábado');
  });
});
