'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { AlertTriangle, CalendarOff, Loader2, Phone, X } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { WEEKDAY_LABELS, addDays, formatDateBR, weekdayOfDate } from '@/lib/datetime';
import { formatPhoneBR } from '@/lib/format';

type Professional = { id: string; name: string; active: boolean };
type Hour = { professionalId: string | null; weekday: number; opensAt: string; closesAt: string };

type Conflito = {
  id: string;
  date: string;
  time: string;
  clientName: string;
  clientPhone: string;
  professionalName: string | null;
  services: string;
};

type Props = {
  date: string;
  hours: Hour[];
  today: string;
  onClose: () => void;
  onDone: () => void;
};

type Periodo = 'dia' | 'manha' | 'tarde' | 'resto' | 'custom';

/** Motivos prontos: um toque preenche o texto e classifica o bloqueio. */
const MOTIVOS: { label: string; kind: 'block' | 'holiday' | 'vacation' | 'dayoff' }[] = [
  { label: 'Compromisso pessoal', kind: 'block' },
  { label: 'Folga', kind: 'dayoff' },
  { label: 'Feriado', kind: 'holiday' },
  { label: 'Férias', kind: 'vacation' },
  { label: 'Curso', kind: 'block' },
  { label: 'Manutenção', kind: 'block' },
];

const trim = (t: string) => t.slice(0, 5);

function proximoQuarto(): string {
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Fechar a agenda.
 *
 * Pensado para o que acontece de verdade no balcão: "saio mais cedo hoje",
 * "chego tarde amanhã", "dentista terça 15h", "feriado", "férias de 10 a 20".
 * Por isso os atalhos vêm antes do formulário — digitar horário é o caminho
 * mais longo, não o primeiro.
 */
export function CloseAgendaDialog({ date, hours, today, onClose, onDone }: Props) {
  const [dataInicio, setDataInicio] = useState(date);
  const [dataFim, setDataFim] = useState('');
  const [periodo, setPeriodo] = useState<Periodo>('dia');
  const [inicio, setInicio] = useState('09:00');
  const [fim, setFim] = useState('12:00');
  const [professionalId, setProfessionalId] = useState<string>('');
  const [motivo, setMotivo] = useState('');
  const [kind, setKind] = useState<'block' | 'holiday' | 'vacation' | 'dayoff'>('block');
  const [repetir, setRepetir] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflitos, setConflitos] = useState<Conflito[] | null>(null);

  const [professionals, setProfessionals] = useState<Professional[]>([]);

  useEffect(() => {
    api
      .get<{ professionals: Professional[] }>('/professionals')
      .then((r) => setProfessionals(r.professionals.filter((p) => p.active)))
      .catch(() => setProfessionals([]));
  }, []);

  // expediente do dia escolhido: base para os atalhos de manhã/tarde
  const expediente = useMemo(() => {
    const weekday = weekdayOfDate(dataInicio);
    const doDia = hours.filter((h) => h.weekday === weekday && !h.professionalId);
    if (!doDia.length) return null;
    const abre = doDia.map((h) => trim(h.opensAt)).sort()[0];
    const fecha = doDia.map((h) => trim(h.closesAt)).sort().at(-1)!;
    return { abre, fecha };
  }, [hours, dataInicio]);

  const abre = expediente?.abre ?? '09:00';
  const fecha = expediente?.fecha ?? '19:00';
  const ehHoje = dataInicio === today;

  /** Traduz o atalho escolhido em início/fim reais. */
  function aplicarPeriodo(p: Periodo) {
    setPeriodo(p);
    if (p === 'manha') {
      setInicio(abre);
      setFim(fecha < '12:00' ? fecha : '12:00');
    } else if (p === 'tarde') {
      setInicio(abre > '12:00' ? abre : '12:00');
      setFim(fecha);
    } else if (p === 'resto') {
      setInicio(proximoQuarto());
      setFim(fecha);
    } else if (p === 'custom') {
      setInicio(abre);
      setFim(fecha);
    }
    if (p === 'dia') setRepetir(false);
  }

  const diaInteiro = periodo === 'dia';
  const varios = Boolean(dataFim && dataFim > dataInicio);

  const resumo = (() => {
    const quem =
      professionalId === ''
        ? 'todos'
        : professionals.find((p) => p.id === professionalId)?.name ?? '';
    const quando = varios
      ? `${formatDateBR(dataInicio)} a ${formatDateBR(dataFim)}`
      : formatDateBR(dataInicio);
    const faixa = diaInteiro ? 'o dia inteiro' : `das ${inicio} às ${fim}`;
    const repeticao = repetir ? ` toda ${WEEKDAY_LABELS[weekdayOfDate(dataInicio)].toLowerCase()}` : '';
    return `Fechar ${faixa}${repeticao ? repeticao : ` em ${quando}`} para ${quem}.`;
  })();

  async function enviar(onConflict: 'abort' | 'keep' | 'cancel') {
    if (!diaInteiro && fim <= inicio) {
      return toast.error('O horário final precisa ser maior que o inicial');
    }

    setBusy(true);
    try {
      const result = await api.post<{ cancelledAppointments?: number; repeated?: boolean }>('/blocks', {
        date: dataInicio,
        endDate: varios ? dataFim : undefined,
        startTime: diaInteiro ? undefined : inicio,
        endTime: diaInteiro ? undefined : fim,
        professionalId: professionalId || null,
        reason: motivo || undefined,
        kind,
        repeatWeekly: repetir,
        onConflict,
      });

      if (result.repeated) toast.success('Pausa fixa criada');
      else if (result.cancelledAppointments) {
        toast.success(`Agenda fechada · ${result.cancelledAppointments} agendamento(s) cancelado(s)`);
      } else toast.success('Agenda fechada');

      onDone();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'has_appointments') {
        setConflitos((err.details as { appointments: Conflito[] }).appointments);
      } else {
        toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível fechar a agenda');
      }
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------- tela de conflito
  if (conflitos) {
    return (
      <Wrapper onClose={onClose} titulo="Tem cliente marcado">
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div className="flex items-start gap-3 rounded-xl border border-state-warn/30 bg-state-warn/5 p-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-state-warn" strokeWidth={1.5} />
            <p className="text-sm leading-relaxed text-ink-200">
              {conflitos.length === 1
                ? 'Há 1 cliente marcado nesse período.'
                : `Há ${conflitos.length} clientes marcados nesse período.`}{' '}
              Decida o que fazer antes de fechar.
            </p>
          </div>

          <ul className="divide-y divide-ink-800">
            {conflitos.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-3">
                <span className="tnum w-20 shrink-0 text-sm text-ink-100">
                  {formatDateBR(c.date).slice(0, 5)} {c.time}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-100">{c.clientName}</span>
                  <span className="block truncate text-xs text-ink-500">
                    {c.services}
                    {c.professionalName ? ` · ${c.professionalName}` : ''}
                  </span>
                </span>
                <a
                  href={`https://wa.me/55${c.clientPhone.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-lg p-2 text-ink-400 transition-colors hover:text-brand-500"
                  title={formatPhoneBR(c.clientPhone)}
                >
                  <Phone size={15} strokeWidth={1.5} />
                </a>
              </li>
            ))}
          </ul>

          <p className="text-xs leading-relaxed text-ink-500">
            Cancelar avisa cada cliente pelo WhatsApp com a mensagem de cancelamento
            configurada. Manter só impede novos agendamentos — quem já está marcado continua.
          </p>
        </div>

        <footer className="safe-bottom space-y-2 border-t border-ink-800 px-5 pt-4">
          <button type="button" disabled={busy} onClick={() => enviar('keep')} className="btn-ghost w-full">
            Manter os agendamentos e fechar o resto
          </button>
          <button type="button" disabled={busy} onClick={() => enviar('cancel')} className="btn-danger w-full">
            {busy && <Loader2 size={15} className="animate-spin" />}
            Cancelar {conflitos.length} agendamento(s) e fechar
          </button>
          <button type="button" onClick={() => setConflitos(null)} className="btn w-full text-ink-400">
            Voltar
          </button>
        </footer>
      </Wrapper>
    );
  }

  // ------------------------------------------------------ formulário
  return (
    <Wrapper onClose={onClose} titulo="Fechar agenda">
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {/* ------------------------------------------------------- quando */}
        <div>
          <p className="label">Quando</p>
          <div className="mb-3 flex flex-wrap gap-2">
            <Chip ativo={dataInicio === today} onClick={() => setDataInicio(today)}>
              Hoje
            </Chip>
            <Chip ativo={dataInicio === addDays(today, 1)} onClick={() => setDataInicio(addDays(today, 1))}>
              Amanhã
            </Chip>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              className="input tnum"
              value={dataInicio}
              onChange={(e) => setDataInicio(e.target.value)}
            />
            <input
              type="date"
              className="input tnum"
              value={dataFim}
              min={dataInicio}
              onChange={(e) => setDataFim(e.target.value)}
              placeholder="até"
            />
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {expediente
              ? `${WEEKDAY_LABELS[weekdayOfDate(dataInicio)]}: ${abre} às ${fecha}.`
              : `${WEEKDAY_LABELS[weekdayOfDate(dataInicio)]} já está fechado no horário de funcionamento.`}
            {' '}A segunda data é opcional — use para férias e emendas.
          </p>
        </div>

        {/* ------------------------------------------------------ período */}
        <div>
          <p className="label">Qual parte do dia</p>
          <div className="flex flex-wrap gap-2">
            <Chip ativo={periodo === 'dia'} onClick={() => aplicarPeriodo('dia')}>
              Dia inteiro
            </Chip>
            <Chip ativo={periodo === 'manha'} onClick={() => aplicarPeriodo('manha')}>
              Manhã
            </Chip>
            <Chip ativo={periodo === 'tarde'} onClick={() => aplicarPeriodo('tarde')}>
              Tarde
            </Chip>
            {ehHoje && (
              <Chip ativo={periodo === 'resto'} onClick={() => aplicarPeriodo('resto')}>
                Resto do dia
              </Chip>
            )}
            <Chip ativo={periodo === 'custom'} onClick={() => aplicarPeriodo('custom')}>
              Escolher horário
            </Chip>
          </div>

          {!diaInteiro && (
            <div className="mt-3 flex items-center gap-2">
              <input
                type="time"
                className="input tnum"
                value={inicio}
                onChange={(e) => {
                  setInicio(e.target.value);
                  setPeriodo('custom');
                }}
              />
              <span className="text-sm text-ink-500">às</span>
              <input
                type="time"
                className="input tnum"
                value={fim}
                onChange={(e) => {
                  setFim(e.target.value);
                  setPeriodo('custom');
                }}
              />
            </div>
          )}
        </div>

        {/* ------------------------------------------------------- quem */}
        {professionals.length > 1 && (
          <div>
            <p className="label">Fechar para quem</p>
            <div className="flex flex-wrap gap-2">
              <Chip ativo={professionalId === ''} onClick={() => setProfessionalId('')}>
                Todos
              </Chip>
              {professionals.map((p) => (
                <Chip
                  key={p.id}
                  ativo={professionalId === p.id}
                  onClick={() => setProfessionalId(p.id)}
                >
                  {p.name}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------------------ motivo */}
        <div>
          <p className="label">Motivo</p>
          <div className="mb-2 flex flex-wrap gap-2">
            {MOTIVOS.map((m) => (
              <Chip
                key={m.label}
                ativo={motivo === m.label}
                onClick={() => {
                  setMotivo(m.label);
                  setKind(m.kind);
                }}
              >
                {m.label}
              </Chip>
            ))}
          </div>
          <input
            className="input"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Só para você lembrar depois"
          />
        </div>

        {/* ---------------------------------------------------- repetir */}
        {!diaInteiro && (
          <label className="flex items-start justify-between gap-3 rounded-xl border border-ink-800 px-3 py-3">
            <span>
              <span className="block text-sm text-ink-200">
                Repetir toda {WEEKDAY_LABELS[weekdayOfDate(dataInicio)].toLowerCase()}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                Vira uma pausa fixa da semana, como o almoço. Sem isso, fecha só nesta data.
              </span>
            </span>
            <input
              type="checkbox"
              checked={repetir}
              onChange={(e) => setRepetir(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-brand-500"
            />
          </label>
        )}

        <p className="rounded-xl bg-ink-850 px-3 py-2.5 text-sm leading-relaxed text-ink-300">
          {resumo}
        </p>
      </div>

      <footer className="safe-bottom flex gap-2 border-t border-ink-800 px-5 pt-4">
        <button type="button" onClick={onClose} className="btn-ghost flex-1">
          Cancelar
        </button>
        <button type="button" disabled={busy} onClick={() => enviar('abort')} className="btn-primary flex-1">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarOff size={15} strokeWidth={1.5} />}
          Fechar agenda
        </button>
      </footer>
    </Wrapper>
  );
}

// ------------------------------------------------------------- primitivos
function Wrapper({
  titulo,
  onClose,
  children,
}: {
  titulo: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 sm:items-center sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-2xl border border-ink-800 bg-ink-900 sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-[15px] text-ink-100">{titulo}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1.5 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
            aria-label="Fechar"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Chip({
  ativo,
  onClick,
  children,
}: {
  ativo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-lg border px-3 py-1.5 text-[13px] transition-colors',
        ativo
          ? 'border-brand-500 bg-brand-500/10 text-ink-100'
          : 'border-ink-800 text-ink-400 hover:border-ink-700 hover:text-ink-200'
      )}
    >
      {children}
    </button>
  );
}
