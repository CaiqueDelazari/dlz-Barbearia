'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Clock, Instagram, Loader2, MapPin, MapPinned,
  MessageCircle, Package, QrCode, Scissors,
} from 'lucide-react';
import { Calendar } from '@/components/Calendar';
import { api, ApiClientError, shortMoney } from '@/lib/api-client';
import { linkWhatsapp, perfilInstagram } from '@/lib/format';
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
  /** Numero da loja: e por ele que o cliente pergunta de um produto. */
  whatsapp: string | null;
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
  allowClientCancel: boolean;
};

/**
 * Onde o contato de quem já agendou fica guardado, no aparelho dele.
 *
 * Uma chave só, e não uma por loja: um domínio serve todas as barbearias, e a
 * pessoa que agenda em duas é a mesma pessoa com o mesmo WhatsApp. Guardar por
 * slug faria ela digitar de novo em cada loja, sem ganhar nada — o dado não sai
 * do navegador dela de um jeito ou de outro.
 */
const CONTATO_KEY = 'agendar:contato';

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

  /**
   * Quem atende e a primeira pergunta, antes ate dos servicos.
   *
   * Foi decidido assim depois de ver a tela pronta: numa barbearia a pessoa
   * volta no barbeiro, nao no corte -- ela reconhece o rosto, e so depois pensa
   * em o que vai fazer. Com um profissional so nao ha o que escolher, mas a
   * tela continua existindo como apresentacao: e onde a foto aparece grande, e
   * no dia em que o segundo barbeiro entrar no cadastro ela vira escolha de
   * verdade sem mudar uma linha.
   *
   * A excecao e a loja com equipe que desligou a escolha em Configuracoes: ali
   * mostrar rosto para depois ignorar a preferencia seria promessa falsa.
   */
  const soloProfessional = professionals.length === 1 ? professionals[0] : null;
  const podeEscolherProfissional = config.allowProfessionalChoice && professionals.length > 1;
  const mostrarPassoProfissional = Boolean(soloProfessional) || podeEscolherProfissional;
  const primeiroPasso: Step = mostrarPassoProfissional ? 'professional' : 'services';

  const [step, setStep] = useState<Step>(primeiroPasso);
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

  /**
   * Nome e WhatsApp de quem já agendou neste aparelho.
   *
   * Cliente de barbearia volta a cada duas ou três semanas, do mesmo celular, e
   * digitava os dois campos toda vez — o passo mais chato de um fluxo que no
   * resto é de tocar e seguir.
   *
   * Fica no aparelho, e não no servidor, porque a busca teria que ser pelo
   * telefone: qualquer um digitaria um número e descobriria de quem é. Aqui o
   * dado é do dono do celular, guardado no celular dele.
   *
   * Tudo em try/catch: aba anônima e navegador com dados de site bloqueados
   * lançam no próprio acesso ao localStorage, e falhar em lembrar não pode
   * impedir de agendar.
   */
  useEffect(() => {
    try {
      const salvo = localStorage.getItem(CONTATO_KEY);
      if (!salvo) return;
      const { name: n, phone: p } = JSON.parse(salvo) as { name?: string; phone?: string };
      if (n) setName(n);
      if (p) setPhone(p);
    } catch {
      // sem memória, o fluxo é o de sempre
    }
  }, []);

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

  // Quem o cliente escolheu, para reaparecer no topo do passo de horario.
  const professionalEmFoco = professionalId
    ? professionals.find((p) => p.id === professionalId) ?? null
    : soloProfessional;

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

  function escolherProfissional(id: string | null) {
    setProfessionalId(id);
    // trocar de barbeiro muda os horarios livres: o dia carregado nao vale mais
    setDate(null);
    setDay(null);
    setSlot(null);
    setStep('services');
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

      // Só depois de dar certo: guardar um telefone que o servidor recusou
      // faria o erro voltar sozinho na próxima visita.
      try {
        localStorage.setItem(CONTATO_KEY, JSON.stringify({ name: name.trim(), phone }));
      } catch {
        // navegador sem armazenamento; o agendamento já está feito
      }

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
    professional: soloProfessional ? 'Quem vai te atender' : 'Com quem você quer ser atendido',
    datetime: 'Escolha o dia e o horário',
    contact: 'Seus dados',
    payment: 'Pagamento',
    done: 'Horário confirmado',
  };

  function goBack() {
    if (step === 'services') setStep('professional');
    else if (step === 'datetime') setStep('services');
    else if (step === 'contact') setStep('datetime');
    else if (step === 'payment') setStep('contact');
  }

  const stepIndex = Math.max(0, STEP_ORDER.indexOf(step === 'professional' ? 'services' : step));

  return (
    <div className="mx-auto flex screen-min w-full max-w-lg flex-col">
      {/* ---------------------------------------------------------- header */}
      {/* Fundo solido, sem `backdrop-blur`: o desfoque em elemento grudado e
          conhecido por piscar e por travar a rolagem no Safari do iPhone, e
          sobre um fundo quase preto ninguem ve diferenca entre os dois. */}
      <header className="sticky top-0 z-20 bg-ink-950">
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          {step !== primeiroPasso && step !== 'done' ? (
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
            {/* Com logo, ela fala pelo salao: repetir o nome embaixo seria dizer
                duas vezes a mesma coisa num cabecalho que ja e apertado. O nome
                continua no DOM para leitor de tela e para quando a imagem falhar. */}
            {tenant.logoUrl ? (
              <>
                {/* Caixa alta e estreita porque a marca aqui e um brasao
                    empilhado (monograma sobre duas linhas de texto), nao uma
                    assinatura deitada. Numa caixa larga o `object-contain`
                    encolheria pela altura e o nome viraria borrao. */}
                <span className="relative mx-auto block h-12 w-[76px]">
                  <Image
                    src={tenant.logoUrl}
                    alt={tenant.name}
                    fill
                    sizes="76px"
                    className="object-contain"
                    priority
                  />
                </span>
                <span className="sr-only">{tenant.name}</span>
              </>
            ) : (
              <p className="display text-[19px] leading-none tracking-wider text-ink-100">{tenant.name}</p>
            )}
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

            {mostrandoVitrine && <Vitrine products={products} tenant={tenant} />}

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
                      className="flex w-full items-center gap-4 py-4 text-left transition-colors active:bg-ink-900"
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
        {step === 'professional' && soloProfessional && (
          <Apresentacao professional={soloProfessional} />
        )}

        {step === 'professional' && !soloProfessional && (
          <section className="animate-fade-up">
            {/* A foto vem antes do nome e ocupa 72px: o cliente volta pelo rosto
                de quem cortou da ultima vez, nao pela grafia do nome. */}
            <ul className="divide-y divide-ink-800">
              {professionals.map((professional) => {
                const escolhido = professionalId === professional.id;
                return (
                  <li key={professional.id}>
                    <button
                      type="button"
                      onClick={() => escolherProfissional(professional.id)}
                      className="flex w-full items-center gap-4 py-4 text-left transition-colors active:bg-ink-900"
                    >
                      <Retrato professional={professional} size={72} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] text-ink-100">{professional.name}</span>
                        {professional.bio && (
                          <span className="eyebrow mt-1 block truncate normal-case tracking-wider">
                            {professional.bio}
                          </span>
                        )}
                      </span>
                      {/* Quem voltou para trocar precisa ver onde estava. */}
                      {escolhido ? (
                        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-brand-500">
                          <Check size={12} strokeWidth={2.5} className="text-ink-950" />
                        </span>
                      ) : (
                        <ChevronRight size={16} strokeWidth={1.5} className="shrink-0 text-ink-500" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Fica por ultimo e mais discreto: quem nao tem preferencia acha
                assim mesmo, e quem tem nao passa reto pelo rosto que procura. */}
            <button
              type="button"
              onClick={() => escolherProfissional(null)}
              className="rule mt-2 flex w-full items-center justify-between gap-4 py-4 text-left"
            >
              <span>
                <span className="block text-sm text-ink-300">Tanto faz quem atende</span>
                <span className="eyebrow mt-1 block normal-case tracking-wider">
                  Mostra todos os horários livres
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={1.5} className="shrink-0 text-ink-500" />
            </button>
          </section>
        )}

        {/* ------------------------------------------------------ data/hora */}
        {step === 'datetime' && (
          <section className="animate-fade-up space-y-5">
            {professionalEmFoco && (
              <QuemAtende
                professional={professionalEmFoco}
                onTrocar={podeEscolherProfissional ? () => setStep('professional') : null}
              />
            )}

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
              {/* "Enviamos" era dito antes de enviar: a confirmação entra na
                  fila e sai quando o worker roda. Prometer no futuro é o que a
                  tela consegue cumprir — e o resumo logo abaixo já mostra tudo,
                  então nada depende da mensagem chegar. */}
              <p className="mt-2 text-sm leading-relaxed text-ink-400">
                Seu horário está confirmado. Você vai receber os detalhes no seu WhatsApp.
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
              // Abre no mapa em vez de virar texto para copiar na mão. Quem
              // está vendo isto vai até lá — e no celular, uma barbearia nova
              // se acha pelo mapa, não pelo nome da rua.
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${tenant.name} ${tenant.address}`
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 text-xs text-ink-500 underline decoration-ink-700 underline-offset-4"
              >
                <MapPin size={12} strokeWidth={1.5} /> {tenant.address}
              </a>
            )}

            {/* O texto segue a configuração da loja. Com o cancelamento
                desligado, prometer "cancelar" mandava o cliente para uma tela
                sem o botão — e quem não consegue cancelar não avisa, só não
                aparece. A falta o barbeiro descobre com a cadeira vazia, sem
                tempo de encaixar outro. */}
            <a href={`/agendamento/${booking.manageToken}`} className="btn-ghost w-full">
              {config.allowClientCancel ? 'Ver, remarcar ou cancelar' : 'Ver ou remarcar'}
            </a>
          </section>
        )}
      </main>

      {/* ------------------------------------------------- barra inferior */}
      {(['services', 'datetime', 'contact'].includes(step) ||
        (step === 'professional' && soloProfessional)) && (
        <footer className="dock-bottom safe-bottom sticky z-20 border-t border-ink-800 bg-ink-950 px-5 pt-4">
          {selected.length > 0 && (
            <div className="mb-3 flex items-baseline justify-between">
              <span className="tnum text-lg text-ink-100">{shortMoney(totalAmount)}</span>
              <span className="eyebrow">
                {totalDuration} min · {selected.length} {selected.length > 1 ? 'serviços' : 'serviço'}
              </span>
            </div>
          )}

          {step === 'professional' && soloProfessional && (
            <button
              type="button"
              onClick={() => escolherProfissional(soloProfessional.id)}
              className="btn-primary w-full py-3.5 text-[15px]"
            >
              Continuar com {soloProfessional.name.split(' ')[0]}
            </button>
          )}

          {step === 'services' && (
            <button
              type="button"
              disabled={!selectedIds.length}
              onClick={() => setStep('datetime')}
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
 * Rosto do profissional, redondo. Cai nas iniciais quando ainda não subiram a
 * foto — um circulo vazio pareceria imagem quebrada.
 */
function Retrato({ professional, size }: { professional: Professional; size: number }) {
  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-850 text-sm tracking-wider text-ink-300"
      style={{ height: size, width: size }}
    >
      {professional.photoUrl ? (
        <Image
          src={professional.photoUrl}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-cover"
        />
      ) : (
        initials(professional.name)
      )}
    </span>
  );
}

/**
 * A tela de um profissional só: apresentação, não escolha.
 *
 * A foto grande é o ponto — é o que o cliente reconhece e o que faz a página
 * parecer da barbearia dele, e não de um sistema. Nada de "Barbeiro" escrito
 * embaixo: aqui também agendam salão e estúdio, e o rótulo sairia errado na
 * casa dos outros. Sem bio cadastrada, o nome basta; o título do passo, logo
 * acima, já diz o que essa pessoa é.
 */
function Apresentacao({ professional }: { professional: Professional }) {
  return (
    <section className="animate-fade-up flex flex-col items-center pt-8 text-center">
      <Retrato professional={professional} size={168} />
      <h2 className="display mt-7 text-[26px] leading-none tracking-wide text-ink-100">
        {professional.name}
      </h2>
      {professional.bio && (
        <p className="mt-3 max-w-[22rem] text-sm leading-relaxed text-ink-400">{professional.bio}</p>
      )}
    </section>
  );
}

/**
 * "Quem vai te atender", no alto do passo de horário.
 *
 * Serve aos dois casos: na barbearia de um só, apresenta — e a foto aparece
 * antes de escolher a hora, sem custar um passo. Com equipe, confirma a escolha
 * que acabou de ser feita e deixa desfazer ali mesmo, porque errar o barbeiro
 * na tela anterior só se descobre aqui.
 */
function QuemAtende({
  professional,
  onTrocar,
}: {
  professional: Professional;
  onTrocar: (() => void) | null;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-ink-800 pb-5">
      <Retrato professional={professional} size={56} />
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Quem vai te atender</p>
        <p className="mt-1 truncate text-[15px] text-ink-100">{professional.name}</p>
        {professional.bio && (
          <p className="mt-0.5 truncate text-xs text-ink-400">{professional.bio}</p>
        )}
      </div>
      {onTrocar && (
        <button
          type="button"
          onClick={onTrocar}
          className="eyebrow shrink-0 py-2 underline underline-offset-4"
        >
          Trocar
        </button>
      )}
    </div>
  );
}

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
 * Não entra no carrinho de propósito — aqui é mostruário, não loja. Produto não
 * tem duração e tem estoque, e deixá-lo entrar no agendamento significaria
 * segurar a prateleira por conta de uma reserva que ainda pode expirar.
 *
 * Mas "não vende" não é desculpa para uma lista morta: o cliente tocava no
 * produto e a tela não respondia, o que se sente como defeito, não como
 * decisão. Tocar agora abre a descrição e o botão de perguntar pelo WhatsApp
 * — a venda continua acontecendo no balcão, onde o estoque baixa de verdade,
 * só que agora ela começa aqui.
 */
function Vitrine({ products, tenant }: { products: Product[]; tenant: TenantInfo }) {
  const [abertoId, setAbertoId] = useState<string | null>(null);

  const grupos = new Map<string, Product[]>();
  for (const product of products) {
    const chave = product.category?.trim() || 'Outros';
    const atual = grupos.get(chave);
    if (atual) atual.push(product);
    else grupos.set(chave, [product]);
  }

  const temWhatsapp = Boolean(linkWhatsapp(tenant.whatsapp));

  return (
    <div className="animate-fade-up">
      <p className="mb-5 text-center text-xs leading-relaxed text-ink-500">
        O que usamos e revendemos.{' '}
        {temWhatsapp
          ? 'Toque no produto para perguntar pelo WhatsApp.'
          : 'Toque no produto para ver os detalhes e peça no balcão.'}
      </p>

      {[...grupos].map(([categoria, itens]) => (
        <section key={categoria} className="mb-6">
          {grupos.size > 1 && <p className="eyebrow mb-2">{categoria}</p>}

          <ul className="divide-y divide-ink-800">
            {itens.map((product) => {
              const aberto = abertoId === product.id;
              const whats = linkWhatsapp(
                tenant.whatsapp,
                `Oi! Vi ${product.name}${product.brand ? ` da ${product.brand}` : ''} `
                  + `(${shortMoney(product.price)}) na página de agendamento da ${tenant.name}. `
                  + 'Ainda tem?'
              );

              return (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => setAbertoId(aberto ? null : product.id)}
                    aria-expanded={aberto}
                    className="flex w-full items-center gap-4 py-4 text-left transition-colors active:bg-ink-900"
                  >
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

                    {/* A seta é o que diz que a linha responde ao toque. */}
                    <ChevronDown
                      size={16}
                      strokeWidth={1.5}
                      className={clsx(
                        'shrink-0 text-ink-500 transition-transform duration-200',
                        aberto && 'rotate-180 text-ink-300'
                      )}
                    />
                  </button>

                  {aberto && (
                    <div className="animate-fade-up space-y-3 pb-5 pl-[72px]">
                      {product.description && (
                        <p className="text-sm leading-relaxed text-ink-300">{product.description}</p>
                      )}

                      {whats ? (
                        <a
                          href={whats}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="btn-ghost w-full"
                        >
                          <MessageCircle size={15} strokeWidth={1.5} /> Perguntar no WhatsApp
                        </a>
                      ) : (
                        <p className="text-xs leading-relaxed text-ink-500">
                          Peça no balcão no dia do seu horário.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
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
