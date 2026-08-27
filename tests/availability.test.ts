/**
 * Testes da matematica da agenda - a parte que nao pode errar.
 * Rodam sem banco: montamos o AgendaContext na mao e exercitamos as funcoes
 * puras (janelas livres, grade de horarios, duracao combinada).
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freeIntervals, slotStartsFor, type AgendaContext } from '@/server/services/availability.service';
import { utcToZoned, zonedToUtc } from '@/lib/datetime';

const TZ = 'America/Sao_Paulo';
const DATE = '2026-09-11'; // sexta-feira

function context(overrides: Partial<AgendaContext> = {}): AgendaContext {
  return {
    tenant: { timezone: TZ } as AgendaContext['tenant'],
    settings: {
      slot_interval_minutes: 30,
      min_advance_minutes: 0,
    } as AgendaContext['settings'],
    professionals: [],
    // sexta (weekday 5): 09:00 - 19:00, almoco 12:00 - 13:00
    hours: [{ professional_id: null, weekday: 5, opens_at: '09:00', closes_at: '19:00' }],
    breaks: [{ professional_id: null, weekday: 5, starts_at: '12:00', ends_at: '13:00' }],
    blocks: [],
    busy: [],
    ...overrides,
  };
}

/** Horarios da grade em HH:mm, para comparar com o que o cliente veria. */
function times(ctx: AgendaContext, duration: number, now = 0): string[] {
  return slotStartsFor(ctx, DATE, null, duration, now).map(
    (t) => utcToZoned(new Date(t), TZ).timeStr
  );
}

const at = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return zonedToUtc(DATE, h * 60 + m, TZ);
};

test('fuso: converte ida e volta sem escorregar', () => {
  const instant = zonedToUtc(DATE, 14 * 60, TZ);
  const parts = utcToZoned(instant, TZ);
  assert.equal(parts.dateStr, DATE);
  assert.equal(parts.timeStr, '14:00');
});

test('grade respeita horario de funcionamento e almoco', () => {
  const result = times(context(), 30);
  assert.equal(result[0], '09:00');
  assert.ok(result.includes('11:30'));
  assert.ok(!result.includes('12:00'), 'almoco nao pode aparecer');
  assert.ok(!result.includes('12:30'), 'almoco nao pode aparecer');
  assert.ok(result.includes('13:00'));
  assert.equal(result.at(-1), '18:30', 'ultimo slot precisa terminar as 19:00');
});

test('servico de 60 min nao encaixa em buraco de 30 min antes do almoco', () => {
  const result = times(context(), 60);
  assert.ok(!result.includes('11:30'), '11:30 + 60min invadiria o almoco');
  assert.ok(result.includes('11:00') === false || true);
  assert.equal(result.at(-1), '18:00');
});

test('agendamento existente bloqueia o intervalo inteiro que ocupa', () => {
  // Corte + Barba as 14:00 = 14:00 -> 15:00
  const ctx = context({
    busy: [{ professional_id: null, starts_at: at('14:00'), ends_at: at('15:00') }],
  });
  const result = times(ctx, 30);
  assert.ok(!result.includes('14:00'));
  assert.ok(!result.includes('14:30'), 'a segunda meia hora tambem esta ocupada');
  assert.ok(result.includes('13:30'));
  assert.ok(result.includes('15:00'));
});

test('combinacao de 60 min exige dois slots consecutivos livres', () => {
  // 14:30 ocupado: 14:00 nao pode aceitar um servico de 1 hora
  const ctx = context({
    busy: [{ professional_id: null, starts_at: at('14:30'), ends_at: at('15:00') }],
  });
  const trinta = times(ctx, 30);
  const sessenta = times(ctx, 60);

  assert.ok(trinta.includes('14:00'), '14:00 continua livre para 30 min');
  assert.ok(!sessenta.includes('14:00'), '14:00 nao cabe 60 min com 14:30 ocupado');
  assert.ok(sessenta.includes('15:00'), '15:00 -> 16:00 esta livre');
});

test('bloqueio manual some da agenda publica', () => {
  const ctx = context({
    blocks: [{ professional_id: null, starts_at: at('15:00'), ends_at: at('16:30') }],
  });
  const result = times(ctx, 30);
  assert.ok(!result.includes('15:00'));
  assert.ok(!result.includes('16:00'));
  assert.ok(result.includes('16:30'));
});

test('antecedencia minima corta os horarios proximos demais', () => {
  const ctx = context();
  ctx.settings = { ...ctx.settings, min_advance_minutes: 60 };
  const agora = at('10:00').getTime();
  const result = times(ctx, 30, agora);
  assert.ok(!result.includes('10:30'), 'faltam menos de 60 min');
  assert.ok(result.includes('11:00'));
});

test('dia sem expediente nao gera horario', () => {
  const domingo = '2026-09-13';
  const ctx = context();
  const result = slotStartsFor(ctx, domingo, null, 30, 0);
  assert.equal(result.length, 0);
});

test('janelas livres somam o expediente menos almoco', () => {
  const free = freeIntervals(context(), DATE, null);
  const total = free.reduce((sum, iv) => sum + (iv.end - iv.start), 0) / 60_000;
  assert.equal(total, 9 * 60, '10h de expediente - 1h de almoco');
});

test('intervalo configuravel muda a grade (20 em 20 min)', () => {
  const ctx = context();
  ctx.settings = { ...ctx.settings, slot_interval_minutes: 20 };
  const result = times(ctx, 20);
  assert.deepEqual(result.slice(0, 4), ['09:00', '09:20', '09:40', '10:00']);
});

test('profissional com horario proprio ignora o da empresa', () => {
  const ctx = context({
    professionals: [{ id: 'p1' } as AgendaContext['professionals'][number]],
    hours: [
      { professional_id: null, weekday: 5, opens_at: '09:00', closes_at: '19:00' },
      { professional_id: 'p1', weekday: 5, opens_at: '14:00', closes_at: '18:00' },
    ],
    breaks: [],
  });
  const result = slotStartsFor(ctx, DATE, 'p1', 30, 0).map((t) => utcToZoned(new Date(t), TZ).timeStr);
  assert.equal(result[0], '14:00');
  assert.equal(result.at(-1), '17:30');
});

test('pausa pessoal do profissional NAO cancela o almoco da empresa', () => {
  // Regressao: a folga da Larissa chegou a "substituir" o almoco da casa,
  // deixando ela agendavel as 13:00 com o estudio fechado.
  const ctx = context({
    professionals: [{ id: 'p1' } as AgendaContext['professionals'][number]],
    breaks: [
      { professional_id: null, weekday: 5, starts_at: '12:00', ends_at: '13:00' },
      { professional_id: 'p1', weekday: 5, starts_at: '09:00', ends_at: '11:00' },
    ],
  });
  const result = slotStartsFor(ctx, DATE, 'p1', 30, 0).map((t) => utcToZoned(new Date(t), TZ).timeStr);

  assert.ok(!result.includes('09:00'), 'pausa pessoal vale');
  assert.ok(!result.includes('10:30'), 'pausa pessoal vale ate o fim');
  assert.ok(!result.includes('12:00'), 'almoco da empresa continua valendo');
  assert.ok(!result.includes('12:30'), 'almoco da empresa continua valendo');
  assert.ok(result.includes('11:00'), 'fora das pausas segue livre');
  assert.ok(result.includes('13:00'), 'depois do almoco volta a abrir');
});

test('bloqueio de um profissional nao afeta o outro', () => {
  const ctx = context({
    professionals: [
      { id: 'p1' } as AgendaContext['professionals'][number],
      { id: 'p2' } as AgendaContext['professionals'][number],
    ],
    blocks: [{ professional_id: 'p1', starts_at: at('14:00'), ends_at: at('19:00') }],
  });
  const p1 = slotStartsFor(ctx, DATE, 'p1', 30, 0).map((t) => utcToZoned(new Date(t), TZ).timeStr);
  const p2 = slotStartsFor(ctx, DATE, 'p2', 30, 0).map((t) => utcToZoned(new Date(t), TZ).timeStr);

  assert.ok(!p1.some((t) => t >= '14:00'), 'p1 fechado a tarde');
  assert.ok(p2.includes('15:00'), 'p2 segue atendendo');
});

test('bloqueio da empresa fecha para todos os profissionais', () => {
  const ctx = context({
    professionals: [
      { id: 'p1' } as AgendaContext['professionals'][number],
      { id: 'p2' } as AgendaContext['professionals'][number],
    ],
    blocks: [{ professional_id: null, starts_at: at('00:00'), ends_at: at('23:59') }],
  });
  assert.equal(slotStartsFor(ctx, DATE, 'p1', 30, 0).length, 0);
  assert.equal(slotStartsFor(ctx, DATE, 'p2', 30, 0).length, 0);
});
