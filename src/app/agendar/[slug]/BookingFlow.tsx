'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  ArrowLeft, Check, ChevronRight, Clock, Instagram, Loader2, MapPin, MapPinned, Package, QrCode,
  Scissors,
} from 'lucide-react';
import { Calendar } from '@/components/Calendar';
import { api, ApiClientError, shortMoney } from '@/lib/api-client';
import { perfilInstagram } from '@/lib/format';
import { addDays, formatDateLong, humanDuration, todayInTz } from '@/lib/datetime';

// ---------------------------------------------------------------- contratos
type Service = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  durationMinutes: number;
  imageUrl: string | null;
  category: string | null;
};

type Professional = { id: string; name: string; photoUrl: string | null; bio: string | null };

type TenantInfo = {
  slug: string;
  name: string;
  address: string | null;
  instagram: string | null;
  logoUrl: string | null;
  timezone: string;
};

type BookingConfig = {
  depositPercent: number;
  allowDeposit: boolean;
  allowFullPayment: boolean;
  paymentRequired: boolean;
  paymentMethods: string[];
  allowProfessionalChoice: boolean;
  allowSplit: boolean;
  maxAdvanceDays: number;
  holdMinutes: number;
};

type Slot = {
  time: string;
  startsAt: string;
  endsAt: string;
  professionalId: string | null;
  professionalName: string | null;
};

type DayAvailability = {
  date: string;
  totalDurationMinutes: number;
  totalAmount: number;
  fitsTogether: boolean;
  slots: Slot[];
  perService?: { serviceId: string; name: string; durationMinutes: number; price: number; slots: Slot[] }[];
};

/**
 * Produto na vitrine. Sem duração, sem estoque e sem preço de custo: nada disso
 * é assunto de quem está do lado de fora, e aqui não se vende — só se mostra.
 */
type Product = {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  price: number;
  imageUrl: string | null;
};

type Props = {
  tenant: TenantInfo;
  services: Service[];
  professionals: Professional[];
  products: Product[];
  config: BookingConfig;
};

type Step = 'services' | 'professional' | 'datetime' | 'contact' | 'payment' | 'done';

/** Chave da aba de vitrine — nunca colide com nome de categoria de verdade. */
const ABA_PRODUTOS = '__produtos__';

const STEP_ORDER: Step[] = ['services', 'datetime', 'contact', 'payment'];

const SEM_CATEGORIA = 'Outros';

// ------------------------------------------------------------------ helpers
function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const initials = (name: string) =>
  name.split(' ').slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');

const hhmm = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });

// ==========================================================================
export function BookingFlow({ tenant, services, professionals, products, config }: Props) {
  const today = useMemo(() => todayInTz(tenant.timezone), [tenant.timezone]);
  const maxDate = useMemo(() => addDays(today, config.maxAdvanceDays), [today, config.maxAdvanceDays]);

  const [step, setStep] = useState<Step>('services');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [professionalId, setProfessionalId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('__all__');

  const [month, setMonth] = useState(today.slice(0, 7));
  const [monthDays, setMonthDays] = useState<Record<string, boolean>>({});
  const [loadingMonth, setLoadingMonth] = useState(false);

  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<DayAvailability | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);

  const [slot, setSlot] = useState<Slot | null>(null);
  const [splitMode, setSplitMode] = useState(false);
  const [splitSlots, setSplitSlots] = useState<Record<string, Slot>>({});

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [booking, setBooking] = useState<{
    manageToken: string;
    bookingGroupId: string;
    totalAmount: number;
    status: string;
    holdExpiresAt: string | null;
  } | null>(null);

  const [payment, setPayment] = useState<{
    paymentId: string;
    amount: number;
    status: string;
    checkoutUrl: string | null;
    qrCode: string | null;
    qrCodeBase64: string | null;
  } | null>(null);

  // ------------------------------------------------------------ categorias
  const categories = useMemo(() => {
    const found: string[] = [];
    for (const service of services) {
      const key = service.category?.trim() || SEM_CATEGORIA;
      if (!found.includes(key)) found.push(key);
    }
    return found;
  }, [services]);

  /**
   * A vitrine é uma aba a mais, não uma categoria de serviço.
   *
   * Fica com chave própria (`__produtos__`) porque o resto da tela raciocina em
   * cima de `visibleServices`: se produto entrasse como categoria, "Tudo"
   * passaria a misturar coisa que se agenda com coisa que não se agenda, e o
   * rodapé somaria duração de um xampu.
   */
  const temVitrine = products.length > 0;
  const mostrandoVitrine = tab === ABA_PRODUTOS;

  const visibleServices = useMemo(() => {
    if (tab === '__all__' || tab === ABA_PRODUTOS) return services;
    return services.filter((s) => (s.category?.trim() || SEM_CATEGORIA) === tab);
  }, [services, tab]);

  const selected = useMemo(
    () => selectedIds.map((id) => services.find((s) => s.id === id)!).filter(Boolean),
    [selectedIds, services]
  );
  const totalDuration = selected.reduce((sum, s) => sum + s.durationMinutes, 0);
  const totalAmount = selected.reduce((sum, s) => sum + Number(s.price), 0);
  const servicesParam = selectedIds.join(',');

  // ------------------------------------------------------------- calendario
  const loadMonth = useCallback(
    async (targetMonth: string) => {
      if (!servicesParam) return;
      setLoadingMonth(true);
      try {
        const result = await api.get<{ days: { date: string; available: boolean }[] }>(
          `/public/${tenant.slug}/availability?month=${targetMonth}&services=${servicesParam}` +
            (professionalId ? `&professional=${professionalId}` : '')
        );
        setMonthDays(Object.fromEntries(result.days.map((d) => [d.date, d.available])));
      } catch (err) {
        toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível carregar o calendário');
      } finally {
        setLoadingMonth(false);
      }
    },
    [servicesParam, professionalId, tenant.slug]
  );

  useEffect(() => {
    if (step === 'datetime') loadMonth(month);
  }, [step, month, loadMonth]);

  const loadDay = useCallback(
    async (targetDate: string) => {
      setLoadingDay(true);
      setSlot(null);
      setSplitSlots({});
      setSplitMode(false);
      try {
        const result = await api.get<DayAvailability>(
          `/public/${tenant.slug}/availability?date=${targetDate}&services=${servicesParam}` +
            (professionalId ? `&professional=${professionalId}` : '')
        );
        setDay(result);
      } catch (err) {
        toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível carregar os horários');
      } finally {
        setLoadingDay(false);
      }
    },
    [servicesParam, professionalId, tenant.slug]
  );

  // ---------------------------------------------------------------- ações
  function toggleService(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id]
    );
    // combo mudou: a agenda calculada antes não vale mais
    setDate(null);
    setDay(null);
    setSlot(null);
  }

  function goToDateTime() {
    const needsProfessionalStep = config.allowProfessionalChoice && professionals.length > 1;
    setStep(needsProfessionalStep ? 'professional' : 'datetime');
  }

  const splitComplete = selected.every((s) => splitSlots[s.id]);
  const canContinueDateTime = splitMode ? splitComplete : Boolean(slot);

  async function submitBooking() {
    if (!name.trim() || phone.replace(/\D/g, '').length < 10) {
      toast.error('Preencha nome e telefone');
      return;
    }

    const items = splitMode
      ? selected.map((service) => ({
          startsAt: splitSlots[service.id].startsAt,
          serviceIds: [service.id],
          professionalId: splitSlots[service.id].professionalId,
        }))
      : [{ startsAt: slot!.startsAt, serviceIds: selectedIds, professionalId: slot!.professionalId }];

    setSubmitting(true);
    try {
      const result = await api.post<{
        manageToken: string;
        bookingGroupId: string;
        totalAmount: number;
        status: string;
        holdExpiresAt: string | null;
        requiresPayment: boolean;
      }>(`/public/${tenant.slug}/appointments`, {
        items,
        client: { name: name.trim(), phone },
      });

      setBooking(result);
      setStep(result.requiresPayment ? 'payment' : 'done');
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Não foi possível agendar';
      toast.error(message);
      if (err instanceof ApiClientError && err.code === 'slot_taken') {
        setStep('datetime');
        if (date) loadDay(date);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function startPayment(mode: 'deposit' | 'full', method: 'pix' | 'card') {
    if (!booking) return;
    setSubmitting(true);
    try {
      const result = await api.post<{
        paymentId: string;
        amount: number;
        status: string;
        checkoutUrl: string | null;
        qrCode: string | null;
        qrCodeBase64: string | null;
      }>('/payments/checkout', { manageToken: booking.manageToken, mode, method });

      setPayment(result);
      if (!result.qrCode && result.checkoutUrl) window.location.href = result.checkoutUrl;
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Não foi possível gerar o pagamento');
    } finally {
      setSubmitting(false);
    }
  }

  // enquanto o Pix não cai, consultamos o status; quem confirma é o webhook
  useEffect(() => {
    if (!payment?.paymentId || payment.status === 'paid') return;
    const timer = setInterval(async () => {
      try {
        const result = await api.get<{ payment: { status: string } }>(`/payments/${payment.paymentId}`);
        if (result.payment.status === 'paid') {
          clearInterval(timer);
          setStep('done');
        }
      } catch {
        // silencioso: falha de rede não deve poluir a tela de pagamento
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [payment]);

  // ------------------------------------------------------------------ views
  const stepTitles: Record<Step, string> = {
    services: 'Escolha os serviços',
    professional: 'Com quem você quer ser atendido',
    datetime: 'Escolha o dia e o horário',
    contact: 'Seus dados',
    payment: 'Pagamento',
    done: 'Horário confirmado',
  };

  function goBack() {
    if (step === 'professional') setStep('services');
    else if (step === 'datetime')
      setStep(config.allowProfessionalChoice && professionals.length > 1 ? 'professional' : 'services');
    else if (step === 'contact') setStep('datetime');
    else if (step === 'payment') setStep('contact');
  }

  const stepIndex = Math.max(0, STEP_ORDER.indexOf(step === 'professional' ? 'services' : step));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
      {/* ---------------------------------------------------------- header */}
      <header className="sticky top-0 z-20 bg-ink-950/95 backdrop-blur">
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          {step !== 'services' && step !== 'done' ? (
            <button
              type="button"
              onClick={goBack}
              className="-ml-1.5 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100"
              aria-label="Voltar"
            >
              <ArrowLeft size={18} strokeWidth={1.5} />
            </button>
          ) : (
            <span className="w-1" />
          )}

          <div className="flex-1 text-center">
            <p className="display text-[19px] leading-none tracking-wider text-ink-100">{tenant.name}</p>
            <p className="eyebrow mt-1.5">{stepTitles[step]}</p>
          </div>

          <span className="w-1" />
        </div>

        {/* progresso: quatro segmentos de hairline, sem enfeite */}
        {step !== 'done' && (
          <div className="grid grid-cols-4 gap-1 px-5 pb-3">
            {STEP_ORDER.map((s, index) => (
              <span
                key={s}
                className={clsx('h-px transition-colors', index <= stepIndex ? 'bg-brand-500' : 'bg-ink-800')}
              />
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 px-5 pb-6">
        {/* -------------------------------------------------------- serviços */}
        {step === 'services' && (
          <section className="animate-fade-up">
            {(categories.length > 1 || temVitrine) && (
              <nav className="scroll-x mb-4 border-b border-ink-800" aria-label="Categorias">
                <button
                  type="button"
                  onClick={() => setTab('__all__')}
                  className={clsx('tab', tab === '__all__' && 'tab-active')}
                >
                  Tudo
                </button>
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setTab(category)}
                    className={clsx('tab', tab === category && 'tab-active')}
                  >
                    {category}
                  </button>
                ))}
                {temVitrine && (
                  <button
                    type="button"
                    onClick={() => setTab(ABA_PRODUTOS)}
                    className={clsx('tab', mostrandoVitrine && 'tab-active')}
                  >
                    Produtos
                  </button>
                )}
              </nav>
            )}

            {mostrandoVitrine && <Vitrine products={products} />}

            {!mostrandoVitrine && visibleServices.length === 0 && (
              <p className="py-16 text-center text-sm text-ink-400">
                Nenhum serviço nesta categoria.
              </p>
            )}

            {!mostrandoVitrine && (
            <ul className="divide-y divide-ink-800">
              {visibleServices.map((service) => {
                const isSelected = selectedIds.includes(service.id);
                return (
                  <li key={service.id}>
                    <button
                      type="button"
                      onClick={() => toggleService(service.id)}
                      aria-pressed={isSelected}
                      className="flex w-full items-center gap-4 py-4 text-left transition-opacity"
                    >
                      <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-ink-850">
                        {service.imageUrl ? (
                          <Image
                            src={service.imageUrl}
                            alt=""
                            fill
                            sizes="56px"
                            className={clsx('object-cover transition-opacity', !isSelected && 'opacity-80')}
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center">
                            <Scissors size={17} strokeWidth={1.25} className="text-ink-500" />
                          </span>
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-ink-100">{service.name}</span>
                        <span className="eyebrow mt-1 block normal-case tracking-wider text-ink-400">
                          {service.durationMinutes} min
                        </span>
                      </span>

                      <span className="shrink-0 text-right">
                        <span className="tnum block text-[15px] text-ink-200">
                          {shortMoney(service.price)}
                        </span>
                      </span>

                      <span
                        className={clsx(
                          'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border transition-colors',
                          isSelected ? 'border-brand-500 bg-brand-500' : 'border-ink-700'
                        )}
                      >
                        {isSelected && <Check size={12} strokeWidth={2.5} className="text-ink-950" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            )}

            <ContatoRodape tenant={tenant} />
          </section>
        )}

        {/* --------------------------------------------------- profissional */}
        {step === 'professional' && (
          <section className="animate-fade-up divide-y divide-ink-800">
            <button
              type="button"
              onClick={() => {
                setProfessionalId(null);
                setStep('datetime');
              }}
              className="flex w-full items-center gap-4 py-4 text-left"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-ink-800 text-[11px] uppercase tracking-wider text-ink-400">
                —
              </span>
              <span className="flex-1">
                <span className="block text-[15px] text-ink-100">Sem preferência</span>
                <span className="eyebrow mt-1 block normal-case tracking-wider">
                  Mostra todos os horários livres
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={1.5} className="text-ink-500" />
            </button>

            {professionals.map((professional) => (
              <button
                key={professional.id}
                type="button"
                onClick={() => {
                  setProfessionalId(professional.id);
                  setStep('datetime');
                }}
                className="flex w-full items-center gap-4 py-4 text-left"
              >
                <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-850 text-xs tracking-wider text-ink-300">
                  {professional.photoUrl ? (
                    <Image src={professional.photoUrl} alt="" fill sizes="48px" className="object-cover" />
                  ) : (
                    initials(professional.name)
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-ink-100">{professional.name}</span>
                  {professional.bio && (
                    <span className="eyebrow mt-1 block truncate normal-case tracking-wider">
                      {professional.bio}
                    </span>
                  )}
                </span>
                <ChevronRight size={16} strokeWidth={1.5} className="text-ink-500" />
              </button>
            ))}
          </section>
        )}

        {/* ------------------------------------------------------ data/hora */}
        {step === 'datetime' && (
          <section className="animate-fade-up space-y-5">
            <Calendar
              month={month}
              selected={date}
              availability={monthDays}
              minDate={today}
              maxDate={maxDate}
              loading={loadingMonth}
              onMonthChange={setMonth}
              onSelect={(value) => {
                setDate(value);
                loadDay(value);
              }}
            />

            {date && (
              <div>
                <p className="eyebrow mb-3">{formatDateLong(date)}</p>

                {loadingDay && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-400">
                    <Loader2 size={15} className="animate-spin" strokeWidth={1.5} /> Buscando horários
                  </div>
                )}

                {!loadingDay && day && !splitMode && (
                  <>
                    {day.slots.length > 0 ? (
                      <>
                        <div className="grid grid-cols-4 gap-2">
                          {day.slots.map((s) => (
                            <button
                              key={s.startsAt}
                              type="button"
                              onClick={() => setSlot(s)}
                              className={clsx('slot', slot?.startsAt === s.startsAt && 'slot-active')}
                            >
                              {s.time}
                            </button>
                          ))}
                        </div>

                        {/* Assinatura: mostra o bloco inteiro que os serviços ocupam. */}
                        {slot && (
                          <DurationSpan
                            from={slot.time}
                            to={hhmm(slot.endsAt, tenant.timezone)}
                            minutes={totalDuration}
                            professional={slot.professionalName}
                          />
                        )}
                      </>
                    ) : (
                      <div className="space-y-4 py-2">
                        <p className="text-sm leading-relaxed text-ink-300">
                          Não há {humanDuration(totalDuration)} seguidos livres neste dia para os serviços
                          escolhidos.
                        </p>
                        {day.perService && config.allowSplit && (
                          <button type="button" onClick={() => setSplitMode(true)} className="btn-ghost w-full">
                            Ver horários separados
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* ------------------------------------ horários separados */}
                {!loadingDay && day && splitMode && day.perService && (
                  <div className="space-y-6">
                    {day.perService.map((entry) => (
                      <div key={entry.serviceId}>
                        <p className="eyebrow mb-2 normal-case tracking-wider text-ink-200">
                          {entry.name}
                          <span className="ml-2 text-ink-500">{entry.durationMinutes} min</span>
                        </p>
                        {entry.slots.length ? (
                          <div className="grid grid-cols-4 gap-2">
                            {entry.slots.map((s) => (
                              <button
                                key={s.startsAt}
                                type="button"
                                onClick={() =>
                                  setSplitSlots((current) => ({ ...current, [entry.serviceId]: s }))
                                }
                                className={clsx(
                                  'slot',
                                  splitSlots[entry.serviceId]?.startsAt === s.startsAt && 'slot-active'
                                )}
                              >
                                {s.time}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-ink-500">Sem horários neste dia.</p>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setSplitMode(false);
                        setSplitSlots({});
                      }}
                      className="eyebrow underline underline-offset-4"
                    >
                      Voltar para horário único
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* --------------------------------------------------------- dados */}
        {step === 'contact' && (
          <section className="animate-fade-up space-y-6">
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="nome">Nome</label>
                <input
                  id="nome"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Como quer ser chamado"
                  autoComplete="name"
                />
              </div>
              <div>
                <label className="label" htmlFor="telefone">WhatsApp</label>
                <input
                  id="telefone"
                  className="input tnum"
                  value={phone}
                  onChange={(e) => setPhone(maskPhone(e.target.value))}
                  placeholder="(00) 00000-0000"
                  inputMode="tel"
                  autoComplete="tel"
                />
                <p className="mt-2 text-xs leading-relaxed text-ink-500">
                  A confirmação e os lembretes chegam neste número.
                </p>
              </div>
            </div>

            <Resumo
              selected={selected}
              totalAmount={totalAmount}
              totalDuration={totalDuration}
              slot={slot}
              splitMode={splitMode}
              splitSlots={splitSlots}
              date={date}
              timezone={tenant.timezone}
            />
          </section>
        )}

        {/* ----------------------------------------------------- pagamento */}
        {step === 'payment' && booking && (
          <section className="animate-fade-up space-y-5">
            {!payment && (
              <>
                <div className="rule pt-5">
                  <p className="eyebrow">Total dos serviços</p>
                  <p className="tnum mt-1 text-3xl font-light text-ink-100">
                    {shortMoney(booking.totalAmount)}
                  </p>
                  {booking.holdExpiresAt && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
                      <Clock size={12} strokeWidth={1.5} />
                      Horário reservado por {config.holdMinutes} minutos
                    </p>
                  )}
                </div>

                <div className="space-y-4">
                  {config.allowDeposit && (
                    <OpcaoPagamento
                      titulo={`Sinal de ${config.depositPercent}%`}
                      valor={(booking.totalAmount * config.depositPercent) / 100}
                      descricao={`${shortMoney(
                        booking.totalAmount - (booking.totalAmount * config.depositPercent) / 100
                      )} no atendimento`}
                      methods={config.paymentMethods}
                      disabled={submitting}
                      onPick={(method) => startPayment('deposit', method)}
                    />
                  )}
                  {config.allowFullPayment && (
                    <OpcaoPagamento
                      titulo="Valor integral"
                      valor={booking.totalAmount}
                      descricao="Nada a pagar depois"
                      methods={config.paymentMethods}
                      disabled={submitting}
                      onPick={(method) => startPayment('full', method)}
                    />
                  )}
                </div>
              </>
            )}

            {payment?.qrCode && (
              <div className="space-y-4 text-center">
                <p className="eyebrow">Pix de {shortMoney(payment.amount)}</p>
                {payment.qrCodeBase64 && (
                  <img
                    src={`data:image/png;base64,${payment.qrCodeBase64}`}
                    alt="QR Code do Pix"
                    className="mx-auto h-56 w-56 rounded-xl bg-bone p-3"
                  />
                )}
                <div className="text-left">
                  <p className="label">Copia e cola</p>
                  <textarea readOnly value={payment.qrCode} className="input h-20 text-xs" />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(payment.qrCode!);
                      toast.success('Código copiado');
                    }}
                    className="btn-ghost mt-2 w-full"
                  >
                    <QrCode size={15} strokeWidth={1.5} /> Copiar código
                  </button>
                </div>
                <p className="flex items-center justify-center gap-2 text-xs text-ink-400">
                  <Loader2 size={12} className="animate-spin" strokeWidth={1.5} /> Aguardando o pagamento
                </p>
              </div>
            )}
          </section>
        )}

        {/* ------------------------------------------------------ concluído */}
        {step === 'done' && booking && (
          <section className="animate-fade-up space-y-6 pt-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-brand-500/40">
              <Check size={20} strokeWidth={1.5} className="text-brand-500" />
            </div>
            <div>
              <h2 className="display text-2xl tracking-wide text-ink-100">
                Até logo, {name.split(' ')[0]}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-400">
                Seu horário está confirmado. Enviamos os detalhes no seu WhatsApp.
              </p>
            </div>

            <Resumo
              selected={selected}
              totalAmount={totalAmount}
              totalDuration={totalDuration}
              slot={slot}
              splitMode={splitMode}
              splitSlots={splitSlots}
              date={date}
              timezone={tenant.timezone}
            />

            {tenant.address && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-ink-500">
                <MapPin size={12} strokeWidth={1.5} /> {tenant.address}
              </p>
            )}

            <a href={`/agendamento/${booking.manageToken}`} className="btn-ghost w-full">
              Ver, remarcar ou cancelar
            </a>
          </section>
        )}
      </main>

      {/* ------------------------------------------------- barra inferior */}
      {['services', 'datetime', 'contact'].includes(step) && (
        <footer className="safe-bottom sticky bottom-0 z-20 border-t border-ink-800 bg-ink-950/95 px-5 pt-4 backdrop-blur">
          {selected.length > 0 && (
            <div className="mb-3 flex items-baseline justify-between">
              <span className="tnum text-lg text-ink-100">{shortMoney(totalAmount)}</span>
              <span className="eyebrow">
                {totalDuration} min · {selected.length} {selected.length > 1 ? 'serviços' : 'serviço'}
              </span>
            </div>
          )}

          {step === 'services' && (
            <button
              type="button"
              disabled={!selectedIds.length}
              onClick={goToDateTime}
              className="btn-primary w-full py-3.5 text-[15px]"
            >
              Continuar
            </button>
          )}

          {step === 'datetime' && (
            <button
              type="button"
              disabled={!canContinueDateTime}
              onClick={() => setStep('contact')}
              className="btn-primary w-full py-3.5 text-[15px]"
            >
              Continuar
            </button>
          )}

          {step === 'contact' && (
            <button
              type="button"
              disabled={submitting}
              onClick={submitBooking}
              className="btn-primary w-full py-3.5 text-[15px]"
            >
              {submitting && <Loader2 size={16} className="animate-spin" strokeWidth={1.5} />}
              {config.paymentRequired ? 'Ir para o pagamento' : 'Confirmar horário'}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

// ------------------------------------------------------------ subcomponentes
/**
 * Barra de duração: dois ticks e uma hairline mostrando o bloco que os
 * serviços ocupam. É a regra que mais gera dúvida ("por que 14:30 sumiu?"),
 * então ela aparece desenhada em vez de explicada.
 */
function DurationSpan({
  from,
  to,
  minutes,
  professional,
}: {
  from: string;
  to: string;
  minutes: number;
  professional: string | null;
}) {
  return (
    <div className="mt-5 animate-fade-up">
      <div className="flex items-center gap-2">
        <span className="tnum text-sm text-ink-100">{from}</span>
        <span className="relative h-px flex-1 bg-ink-700">
          <span className="absolute -top-1 left-0 h-2 w-px bg-brand-500" />
          <span className="absolute -top-1 right-0 h-2 w-px bg-brand-500" />
        </span>
        <span className="tnum text-sm text-ink-100">{to}</span>
      </div>
      <p className="eyebrow mt-2 text-center">
        {humanDuration(minutes)} reservados{professional ? ` · ${professional}` : ''}
      </p>
    </div>
  );
}

function Resumo({
  selected,
  totalAmount,
  totalDuration,
  slot,
  splitMode,
  splitSlots,
  date,
  timezone,
}: {
  selected: Service[];
  totalAmount: number;
  totalDuration: number;
  slot: Slot | null;
  splitMode: boolean;
  splitSlots: Record<string, Slot>;
  date: string | null;
  timezone: string;
}) {
  return (
    <div className="rule pt-4">
      <ul className="space-y-2.5">
        {selected.map((service) => (
          <li key={service.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink-200">
              {service.name}
              {splitMode && splitSlots[service.id] && (
                <span className="tnum ml-2 text-brand-500">{splitSlots[service.id].time}</span>
              )}
            </span>
            <span className="tnum shrink-0 text-ink-400">{shortMoney(service.price)}</span>
          </li>
        ))}
      </ul>

      {(date || slot) && (
        <div className="mt-4 space-y-1 border-t border-ink-800 pt-4 text-sm text-ink-300">
          {date && <p className="capitalize">{formatDateLong(date)}</p>}
          {!splitMode && slot && (
            <p className="tnum">
              {slot.time} – {hhmm(slot.endsAt, timezone)}
              {slot.professionalName ? ` · ${slot.professionalName}` : ''}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-baseline justify-between border-t border-ink-800 pt-4">
        <span className="eyebrow">Total · {humanDuration(totalDuration)}</span>
        <span className="tnum text-lg text-ink-100">{shortMoney(totalAmount)}</span>
      </div>
    </div>
  );
}

/**
 * Vitrine: o que o estúdio revende.
 *
 * Não tem botão de adicionar de propósito — foi decidido que aqui é mostruário,
 * não loja. Produto não tem duração e tem estoque, então deixá-lo entrar no
 * agendamento significaria segurar a prateleira por conta de uma reserva que
 * ainda pode expirar. Aqui o cliente descobre que existe; a venda acontece no
 * balcão, onde o estoque baixa de verdade.
 */
function Vitrine({ products }: { products: Product[] }) {
  const grupos = new Map<string, Product[]>();
  for (const product of products) {
    const chave = product.category?.trim() || 'Outros';
    const atual = grupos.get(chave);
    if (atual) atual.push(product);
    else grupos.set(chave, [product]);
  }

  return (
    <div className="animate-fade-up">
      <p className="mb-5 text-center text-xs leading-relaxed text-ink-500">
        O que usamos e revendemos. Peça no balcão no dia do seu horário.
      </p>

      {[...grupos].map(([categoria, itens]) => (
        <section key={categoria} className="mb-6">
          {grupos.size > 1 && <p className="eyebrow mb-2">{categoria}</p>}

          <ul className="divide-y divide-ink-800">
            {itens.map((product) => (
              <li key={product.id} className="flex items-center gap-4 py-4">
                <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-ink-850">
                  {product.imageUrl ? (
                    <Image src={product.imageUrl} alt="" fill sizes="56px" className="object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center">
                      <Package size={17} strokeWidth={1.25} className="text-ink-500" />
                    </span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-ink-100">{product.name}</span>
                  {(product.brand || product.description) && (
                    <span className="eyebrow mt-1 block truncate normal-case tracking-wider text-ink-400">
                      {product.brand ?? product.description}
                    </span>
                  )}
                </span>

                <span className="tnum shrink-0 text-[15px] text-ink-200">
                  {shortMoney(product.price)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Onde fica e onde ver o trabalho — as duas perguntas que sobram depois de
 * escolher o serviço.
 *
 * Nada aqui é fixo no código: sai de `tenants.address` e `tenants.instagram`,
 * que o dono preenche em Configurações. Empresa que não preencheu não mostra o
 * ícone, em vez de mostrar um link quebrado.
 */
function ContatoRodape({ tenant }: { tenant: TenantInfo }) {
  const mapa = tenant.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(tenant.address)}`
    : null;
  const instagram = perfilInstagram(tenant.instagram);

  if (!mapa && !instagram) return null;

  const link =
    'flex h-11 w-11 items-center justify-center text-ink-300 transition-colors hover:text-bone';

  return (
    <div className="rule mt-10 flex items-center justify-center gap-6 pt-7">
      {mapa && (
        <a
          href={mapa}
          target="_blank"
          rel="noreferrer noopener"
          className={link}
          title={tenant.address ?? undefined}
          aria-label={`Como chegar — ${tenant.address}`}
        >
          <MapPinned size={24} strokeWidth={1.25} />
        </a>
      )}
      {instagram && (
        <a
          href={instagram.url}
          target="_blank"
          rel="noreferrer noopener"
          className={link}
          title={instagram.handle}
          aria-label={`Instagram ${instagram.handle}`}
        >
          <Instagram size={24} strokeWidth={1.25} />
        </a>
      )}
    </div>
  );
}

function OpcaoPagamento({
  titulo,
  valor,
  descricao,
  methods,
  disabled,
  onPick,
}: {
  titulo: string;
  valor: number;
  descricao: string;
  methods: string[];
  disabled: boolean;
  onPick: (method: 'pix' | 'card') => void;
}) {
  return (
    <div className="rule pt-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[15px] text-ink-100">{titulo}</p>
          <p className="eyebrow mt-1 normal-case tracking-wider">{descricao}</p>
        </div>
        <p className="tnum text-xl font-light text-ink-100">{shortMoney(valor)}</p>
      </div>
      <div className="flex gap-2">
        {methods.includes('pix') && (
          <button type="button" disabled={disabled} onClick={() => onPick('pix')} className="btn-primary flex-1">
            Pix
          </button>
        )}
        {methods.includes('card') && (
          <button type="button" disabled={disabled} onClick={() => onPick('card')} className="btn-ghost flex-1">
            Cartão
          </button>
        )}
      </div>
    </div>
  );
}
