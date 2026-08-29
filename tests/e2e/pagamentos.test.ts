/**
 * Dinheiro e confirmação: reserva temporária, sinal, webhook idempotente,
 * pagamento presencial e o link que o cliente recebe.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { query } from '@/lib/db';
import {
  BASE, ajustarConfig, criarEmpresa, criarServico, diaUtil, dinheiro, fecharPool,
  horarios, rodarWorker, type Empresa,
} from '../helpers/e2e';

let empresa: Empresa;
let corte: { id: string; price: number; durationMinutes: number };

/**
 * Cada reserva usa um dia só dela. Reaproveitar o mesmo dia lotava a agenda no
 * meio da suíte e os testes começavam a falhar por falta de vaga, não por bug.
 */
let proximoDia = 12;
const diaExclusivo = () => diaUtil((proximoDia += 1));

type Reserva = {
  manageToken: string;
  bookingGroupId: string;
  status: string;
  totalAmount: number;
  holdExpiresAt: string | null;
  appointments: { id: string }[];
};

/** Reserva pelo fluxo público (é o único que cria reserva temporária). */
async function reservar(
  nome: string,
  telefone: string
): Promise<Reserva & { dia: string; hora: string }> {
  const dia = diaExclusivo();
  const { slots } = await horarios(empresa, dia, [corte.id]);
  const livre = slots[0];
  assert.ok(livre, `esperava horário livre em ${dia}`);

  const r = await empresa.anon.post(`/public/${empresa.slug}/appointments`, {
    items: [{ startsAt: livre.startsAt, serviceIds: [corte.id], professionalId: livre.professionalId }],
    client: { name: nome, phone: telefone },
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  return { ...(r.data as Reserva), dia, hora: livre.time };
}

/**
 * Mesma reserva, criada pelo painel.
 *
 * O endpoint público aceita 10 agendamentos por minuto por IP — proteção real
 * contra abuso. Testes que não estão medindo o fluxo público usam esta via
 * para não esbarrar no limite (e o link de gerenciamento sai igual).
 */
async function reservarPeloPainel(
  nome: string,
  telefone: string
): Promise<Reserva & { dia: string; hora: string }> {
  const dia = diaExclusivo();
  const { slots } = await horarios(empresa, dia, [corte.id]);
  const livre = slots[0];
  assert.ok(livre, `esperava horário livre em ${dia}`);

  const r = await empresa.api.post('/appointments', {
    items: [{ startsAt: livre.startsAt, serviceIds: [corte.id], professionalId: livre.professionalId }],
    client: { name: nome, phone: telefone },
  });
  assert.equal(r.status, 201, JSON.stringify(r.error));
  return { ...(r.data as Reserva), dia, hora: livre.time };
}

function webhook(paymentId: string, status: string, eventId: string) {
  return fetch(`${BASE}/api/v1/payments/webhook/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paymentId, status, eventId }),
  }).then((r) => r.json());
}

before(async () => {
  empresa = await criarEmpresa('pagamentos');
  await ajustarConfig(empresa, {
    onlinePaymentRequired: true,
    depositPercent: 50,
    minAdvanceMinutes: 0,
    holdExpirationMinutes: 15,
    minimumRescheduleNoticeMinutes: 120,
  });
  corte = await criarServico(empresa, { name: 'Corte', price: 200, durationMinutes: 60 });
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('reserva temporária', () => {
  test('nasce pendente e com prazo para pagar', async () => {
    const reserva = await reservar('Reserva Pendente', '11911110001');
    assert.equal(reserva.status, 'pending');
    assert.ok(reserva.holdExpiresAt, 'precisa ter prazo');
    assert.ok(new Date(reserva.holdExpiresAt!) > new Date());
  });

  test('segura o horário enquanto o prazo corre', async () => {
    const reserva = await reservar('Segura Horário', '11911110002');
    const depois = await horarios(empresa, reserva.dia, [corte.id]);

    // 60 min a partir de 09:00 tiram 09:00 e 09:30 da grade de 30 em 30
    assert.ok(!depois.slots.some((s) => s.time === reserva.hora), 'o horário reservado sumiu');
    assert.ok(!depois.slots.some((s) => s.time === '09:30'), 'a fração seguinte também');
    assert.ok(depois.slots.some((s) => s.time === '10:00'), 'o resto do dia continua livre');
  });
});

describe('cobrança e confirmação', () => {
  test('sinal cobra a porcentagem configurada', async () => {
    const reserva = await reservar('Sinal', '11911110003');
    const checkout = await empresa.anon.post('/payments/checkout', {
      manageToken: reserva.manageToken, mode: 'deposit', method: 'pix',
    });

    assert.equal(checkout.status, 201, JSON.stringify(checkout.error));
    assert.equal(dinheiro(checkout.data.amount), 100, '50% de 200');
    assert.ok(checkout.data.checkoutUrl, 'precisa devolver onde pagar');
  });

  test('clicar duas vezes não gera duas cobranças', async () => {
    const reserva = await reservar('Dois Cliques', '11911110004');
    const body = { manageToken: reserva.manageToken, mode: 'deposit' as const, method: 'pix' as const };
    const um = await empresa.anon.post('/payments/checkout', body);
    const dois = await empresa.anon.post('/payments/checkout', body);

    assert.equal(um.data.paymentId, dois.data.paymentId, 'mesma cobrança');
    const linhas = await query(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND booking_group_id = $2`,
      [empresa.tenantId, reserva.bookingGroupId]
    );
    assert.equal(linhas[0].n, 1);
  });

  test('webhook confirma o agendamento e registra o pago', async () => {
    const reserva = await reservar('Webhook', '11911110005');
    const checkout = await empresa.anon.post('/payments/checkout', {
      manageToken: reserva.manageToken, mode: 'deposit', method: 'pix',
    });

    const evento = await webhook(checkout.data.paymentId, 'paid', `evt-${checkout.data.paymentId}`);
    assert.equal(evento.data.processed, true);

    const booking = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);
    const appt = booking.data.appointments[0];
    assert.equal(appt.status, 'confirmed');
    assert.equal(dinheiro(appt.paid_amount), 100);
    assert.equal(dinheiro(appt.total_amount), 200);
    assert.equal(appt.payment_status, 'partially_paid', 'sinal pago não é conta quitada');
  });

  test('evento repetido não paga duas vezes', async () => {
    const reserva = await reservar('Idempotente', '11911110006');
    const checkout = await empresa.anon.post('/payments/checkout', {
      manageToken: reserva.manageToken, mode: 'full', method: 'pix',
    });
    const eventId = `evt-dup-${checkout.data.paymentId}`;

    const primeiro = await webhook(checkout.data.paymentId, 'paid', eventId);
    const segundo = await webhook(checkout.data.paymentId, 'paid', eventId);

    assert.equal(primeiro.data.processed, true);
    assert.equal(segundo.data.processed, false);
    assert.equal(segundo.data.reason, 'evento duplicado');

    const booking = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);
    assert.equal(dinheiro(booking.data.appointments[0].paid_amount), 200, 'pago exatamente uma vez');
  });

  test('pagamento recusado não confirma o horário', async () => {
    const reserva = await reservar('Recusado', '11911110007');
    const checkout = await empresa.anon.post('/payments/checkout', {
      manageToken: reserva.manageToken, mode: 'full', method: 'pix',
    });
    await webhook(checkout.data.paymentId, 'failed', `evt-fail-${checkout.data.paymentId}`);

    const booking = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);
    assert.equal(booking.data.appointments[0].status, 'pending');
    assert.equal(dinheiro(booking.data.appointments[0].paid_amount), 0);
  });

  test('cobrança de reserva inexistente é recusada', async () => {
    const r = await empresa.anon.post('/payments/checkout', {
      manageToken: 'token-que-nao-existe-nem-de-longe', mode: 'deposit', method: 'pix',
    });
    assert.equal(r.status, 404);
  });
});

describe('consulta pública da cobrança', () => {
  test('o link de gerenciar só sai depois que o pagamento cai', async () => {
    const reserva = await reservar('Token Guardado', '11911110009');
    const checkout = await empresa.anon.post('/payments/checkout', {
      manageToken: reserva.manageToken, mode: 'deposit', method: 'pix',
    });
    const paymentId = checkout.data.paymentId;

    // A tela de pagamento consulta esta rota sem sessão, e o id anda na URL.
    // Entregar o manage_token antes de pagar daria controle da reserva de
    // outra pessoa a quem só viu o endereço num print ou no Referer.
    const antes = await empresa.anon.get(`/payments/${paymentId}`);
    assert.equal(antes.status, 200);
    assert.equal(antes.data.payment.status, 'pending');
    assert.ok(!antes.data.payment.manage_token, 'token não pode sair antes do pagamento');
    assert.ok(antes.data.payment.qr_code !== undefined, 'o que a tela precisa continua vindo');

    await webhook(paymentId, 'paid', `evt-token-${paymentId}`);

    const depois = await empresa.anon.get(`/payments/${paymentId}`);
    assert.equal(depois.data.payment.status, 'paid');
    assert.ok(depois.data.payment.manage_token, 'pagou, recebe o link de gerenciar');
  });

  test('id fora do formato não vira erro de banco', async () => {
    const r = await empresa.anon.get('/payments/isso-nao-e-uuid');
    assert.equal(r.status, 400);
    assert.equal(r.error?.code, 'validation_error');
  });
});

describe('pagamento presencial', () => {
  test('registrar no balcão quita o restante', async () => {
    const reserva = await reservarPeloPainel('Balcão', '11911110008');
    const id = reserva.appointments[0].id;

    // metade agora, metade no fim do atendimento
    const metade = await empresa.api.post(`/appointments/${id}/payments`, { amount: 100, method: 'pix' });
    assert.equal(metade.status, 201);
    assert.equal(metade.data.appointment.payment_status, 'partially_paid');
    assert.equal(dinheiro(metade.data.appointment.paid_amount), 100);

    const resto = await empresa.api.post(`/appointments/${id}/payments`, { amount: 100, method: 'cash' });
    assert.equal(dinheiro(resto.data.appointment.paid_amount), 200);
    assert.equal(resto.data.appointment.payment_status, 'paid');

    const extrato = await empresa.api.get(`/appointments/${id}/payments`);
    assert.equal(extrato.data.payments.length, 2, 'as duas parcelas ficam registradas');
    assert.equal(dinheiro(extrato.data.resumo.restante), 0);
  });

  test('valor negativo é recusado', async () => {
    const reserva = await reservarPeloPainel('Negativo', '11911110009');
    const r = await empresa.api.post(`/appointments/${reserva.appointments[0].id}/payments`, {
      amount: -50, method: 'cash',
    });
    assert.equal(r.status, 400);
  });
});

describe('estorno', () => {
  /** Reserva paga por inteiro, pronta para devolver. */
  async function reservaPaga(nome: string, telefone: string) {
    const reserva = await reservarPeloPainel(nome, telefone);
    const id = reserva.appointments[0].id;
    const pago = await empresa.api.post(`/appointments/${id}/payments`, {
      amount: 200, method: 'pix',
    });
    assert.equal(pago.status, 201);
    assert.equal(pago.data.appointment.payment_status, 'paid');

    const extrato = await empresa.api.get(`/appointments/${id}/payments`);
    const pagamento = extrato.data.payments.find((p: any) => p.status === 'paid');
    assert.ok(pagamento, 'precisa existir um pagamento pago para estornar');
    return { appointmentId: id, paymentId: pagamento.id };
  }

  const ficha = async (id: string) =>
    (await empresa.api.get(`/appointments/${id}`)).data.appointment;

  test('devolver tudo tira do caixa e volta o horário para não pago', async () => {
    const { appointmentId, paymentId } = await reservaPaga('Estorno Total', '11911110020');

    const r = await empresa.api.post(`/payments/${paymentId}/refund`, {
      reason: 'cliente desistiu',
    });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(dinheiro(r.data.refundedNow), 200, 'sem valor no corpo, devolve o que resta');
    assert.equal(r.data.status, 'refunded');

    const depois = await ficha(appointmentId);
    assert.equal(dinheiro(depois.paid_amount), 0, 'o dinheiro sai do atendimento');
    assert.equal(
      depois.payment_status,
      'pending',
      'volta a dever — senão ninguém cobra de novo e o corte sai de graça'
    );
  });

  test('devolver metade mantém o pagamento pago, com a parte devolvida à vista', async () => {
    const { appointmentId, paymentId } = await reservaPaga('Estorno Parcial', '11911110021');

    const r = await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 80 });
    assert.equal(r.status, 200);
    assert.equal(dinheiro(r.data.refundedNow), 80);
    assert.equal(r.data.status, 'paid', 'os outros 120 continuam sendo dinheiro que entrou');

    const depois = await ficha(appointmentId);
    assert.equal(dinheiro(depois.paid_amount), 120);
    assert.equal(depois.payment_status, 'partially_paid');

    const extrato = await empresa.api.get(`/appointments/${appointmentId}/payments`);
    const linha = extrato.data.payments.find((p: any) => p.id === paymentId);
    assert.equal(dinheiro(linha.refundedAmount), 80, 'o extrato mostra quanto voltou');
  });

  test('não devolve mais do que entrou, nem em duas vezes', async () => {
    const { paymentId } = await reservaPaga('Estorno Demais', '11911110022');

    const demais = await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 500 });
    assert.equal(demais.status, 409, 'não se devolve dinheiro que nunca entrou');

    assert.equal((await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 150 })).status, 200);
    const segundo = await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 100 });
    assert.equal(segundo.status, 409, 'o segundo estorno só pode alcançar o que sobrou');

    // e o que sobrou ainda pode sair
    const resto = await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 50 });
    assert.equal(resto.status, 200);
    assert.equal(resto.data.status, 'refunded');
  });

  test('pagamento que nunca foi pago não se estorna', async () => {
    const reserva = await reservarPeloPainel('Nunca Pagou', '11911110023');
    const checkout = await empresa.anon.post('/payments/checkout', {
      bookingGroupId: reserva.bookingGroupId, mode: 'full',
    });
    assert.equal(checkout.status, 201);

    const r = await empresa.api.post(`/payments/${checkout.data.payment.id}/refund`, {});
    assert.equal(r.status, 409, 'pendente se cancela, não se estorna');
  });

  test('o estorno aparece no financeiro sem apagar a entrada', async () => {
    const { paymentId } = await reservaPaga('Estorno Caixa', '11911110024');

    const antes = await empresa.api.get('/financial/summary?range=month');
    await empresa.api.post(`/payments/${paymentId}/refund`, { amount: 200 });
    const depois = await empresa.api.get('/financial/summary?range=month');

    assert.equal(
      dinheiro(depois.data.estornos - antes.data.estornos),
      200,
      'a devolução tem linha própria'
    );
    assert.equal(
      dinheiro(depois.data.entradas),
      dinheiro(antes.data.entradas),
      'Entradas continua sendo o bruto que entrou — o dinheiro entrou mesmo'
    );
    assert.equal(
      dinheiro(antes.data.resultado - depois.data.resultado),
      200,
      'o resultado é que sente a devolução'
    );
  });
});

describe('link do cliente', () => {
  test('mostra o agendamento e a política', async () => {
    const reserva = await reservarPeloPainel('Link', '11911110010');
    const r = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);

    assert.equal(r.status, 200);
    assert.equal(r.data.tenant.slug, empresa.slug);
    assert.equal(r.data.policy.rescheduleNoticeMinutes, 120);
    assert.equal(r.data.appointments[0].canChange, true, 'longe do horário dá para mexer');
  });

  test('cliente remarca dentro da janela', async () => {
    const reserva = await reservarPeloPainel('Remarca', '11911110011');
    const { slots } = await horarios(empresa, diaUtil(18), [corte.id]);
    const novo = slots.at(-1)!;

    const r = await empresa.anon.patch(`/public/booking/${reserva.manageToken}`, {
      appointmentId: reserva.appointments[0].id,
      startsAt: novo.startsAt,
    });

    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(new Date(r.data.appointment.starts_at).toISOString(), new Date(novo.startsAt).toISOString());
  });

  test('cliente cancela e o horário volta para a agenda', async () => {
    const reserva = await reservarPeloPainel('Cancela', '11911110012');
    const ocupado = await horarios(empresa, reserva.dia, [corte.id]);
    assert.ok(!ocupado.slots.some((s) => s.time === reserva.hora));

    const r = await empresa.anon.del(`/public/booking/${reserva.manageToken}`);
    assert.equal(r.status, 200);

    const livre = await horarios(empresa, reserva.dia, [corte.id]);
    assert.ok(livre.slots.some((s) => s.time === reserva.hora), 'horário liberado');
  });

  test('fora da janela mínima o sistema barra', async () => {
    const reserva = await reservarPeloPainel('Em cima da hora', '11911110013');
    // empurra o horário para daqui a 30 min: menos que os 120 exigidos
    await query(
      `UPDATE appointments SET starts_at = now() + interval '30 minutes',
                               ends_at = now() + interval '90 minutes'
        WHERE id = $1`,
      [reserva.appointments[0].id]
    );

    const cancelar = await empresa.anon.del(`/public/booking/${reserva.manageToken}`);
    assert.equal(cancelar.status, 403);
    assert.match(cancelar.error!.message, /2h|120/);

    const visao = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);
    assert.equal(visao.data.appointments[0].canChange, false);
  });

  test('token inválido não abre nada', async () => {
    const r = await empresa.anon.get('/public/booking/token-invalido-qualquer');
    assert.equal(r.status, 404);
  });
});

describe('reserva expirada', () => {
  test('o worker devolve o horário não pago', async () => {
    const reserva = await reservarPeloPainel('Expirada', '11911110014');
    // coloca no estado que o fluxo público deixaria: pendente, com prazo vencido
    await query(
      `UPDATE appointments
          SET status = 'pending', hold_expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [reserva.appointments[0].id]
    );

    // O horário volta assim que o prazo vence: a disponibilidade ignora reserva
    // vencida na hora, sem esperar o cron. O job existe para fechar a linha.
    const jaLivre = await horarios(empresa, reserva.dia, [corte.id]);
    assert.ok(jaLivre.slots.some((s) => s.time === reserva.hora), 'prazo vencido não segura horário');

    const job = await rodarWorker(empresa);

    assert.ok(job.reservasExpiradas >= 1, 'o job precisa expirar a reserva');

    const booking = await empresa.anon.get(`/public/booking/${reserva.manageToken}`);
    assert.equal(booking.data.appointments[0].status, 'cancelled', 'o job fecha a reserva vencida');

    const avisos = await query(
      `SELECT status FROM notifications WHERE tenant_id = $1 AND appointment_id = $2`,
      [empresa.tenantId, reserva.appointments[0].id]
    );
    assert.ok(
      avisos.every((n: any) => n.status !== 'scheduled'),
      'lembretes da reserva morta não podem continuar na fila'
    );
  });
});
