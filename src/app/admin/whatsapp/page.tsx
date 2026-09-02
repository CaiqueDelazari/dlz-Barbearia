'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { CheckCircle2, Loader2, QrCode, RefreshCw, Send, XCircle } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

type StatusResponse = {
  sessionId: string;
  status: { configured?: boolean; connected?: boolean; conectada?: boolean; error?: string } & Record<string, unknown>;
  session: SessionSnapshot | null;
};

type SessionSnapshot = {
  status: 'conectado' | 'aguardando_leitura' | 'desconectado';
  qrcode: string;
  numero: string;
};

export default function WhatsappPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [pairing, setPairing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<StatusResponse>('/whatsapp/status'));
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao consultar o gateway');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Pede o QR ao bot pelo nosso servidor. O token do bot nunca chega aqui: a
  // tela recebe so a imagem pronta.
  async function pair() {
    setPairing(true);
    try {
      const res = await api.post<{ session: SessionSnapshot | null }>('/whatsapp/connect', {});
      if (!res.session || res.session.status === 'desconectado') {
        toast.error('O bot nao devolveu o QR. Confira se o gateway esta no ar.');
      }
      setData((prev) => (prev ? { ...prev, session: res.session } : prev));
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao iniciar o pareamento');
    } finally {
      setPairing(false);
    }
  }

  async function sendTest() {
    if (!phone || !message) return toast.error('Informe telefone e mensagem');
    setSending(true);
    try {
      await api.post('/notifications/send', { phone, message });
      toast.success('Mensagem colocada na fila');
      setMessage('');
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao enviar');
    } finally {
      setSending(false);
    }
  }

  const connected = Boolean(data?.status?.connected ?? data?.status?.conectada);
  const configured = data?.status?.configured !== false;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">WhatsApp</h1>
          <p className="text-sm text-ink-400">Conexão usada para confirmações e lembretes</p>
        </div>
        <button type="button" onClick={load} className="btn-ghost">
          <RefreshCw size={15} /> Atualizar
        </button>
      </header>

      {loading && !data ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <>
          <section className="card p-5">
            <div className="flex items-center gap-3">
              {connected ? (
                <CheckCircle2 size={22} className="text-brand-500" />
              ) : (
                <XCircle size={22} className="text-state-bad" />
              )}
              <div className="flex-1">
                <p className="text-sm font-semibold text-ink-100">
                  {connected ? 'Conectado' : configured ? 'Desconectado' : 'Gateway não configurado'}
                </p>
                <p className="text-xs text-ink-500">
                  Sessão: <code className="text-ink-300">{data?.sessionId}</code>
                </p>
              </div>
            </div>

            {!configured && (
              <p className="mt-4 rounded-xl bg-ink-850 p-3 text-xs leading-relaxed text-ink-400">
                Defina <code className="text-brand-500">WHATSAPP_ENABLED=true</code>,{' '}
                <code className="text-brand-500">WHATSAPP_API_URL</code> e{' '}
                <code className="text-brand-500">WHATSAPP_TOKEN</code> no ambiente para ligar o gateway.
                Sem isso as mensagens ficam na fila com status <em>skipped</em>.
              </p>
            )}

            {!connected && configured && (
              <div className="mt-4 space-y-3">
                <button className="btn-primary w-full sm:w-auto" onClick={pair} disabled={pairing}>
                  {pairing ? <Loader2 size={15} className="animate-spin" /> : <QrCode size={15} />}
                  {pairing ? 'Gerando QR Code...' : 'Gerar QR Code para parear'}
                </button>

                {data?.session?.status === 'aguardando_leitura' && data.session.qrcode && (
                  <div className="rounded-xl bg-white p-3 text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={data.session.qrcode}
                      alt="QR Code para parear o WhatsApp"
                      className="mx-auto h-[260px] w-[260px]"
                    />
                    <p className="mt-2 text-xs text-ink-900">
                      WhatsApp → Aparelhos conectados → Conectar aparelho
                    </p>
                  </div>
                )}

                <button className="btn-ghost w-full sm:w-auto" onClick={load}>
                  <RefreshCw size={15} /> Ja escaneei, conferir
                </button>
              </div>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink-100">Enviar mensagem avulsa</h2>
            <div className="space-y-3">
              <div>
                <label className="label">Telefone</label>
                <input
                  className="input"
                  inputMode="tel"
                  placeholder="(00) 00000-0000"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Mensagem</label>
                <textarea
                  className="input h-24 resize-y"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>
              <button type="button" disabled={sending} onClick={sendTest} className="btn-primary w-full sm:w-auto">
                {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Enviar
              </button>
            </div>
          </section>

          <section className={clsx('card p-5 text-xs leading-relaxed text-ink-400')}>
            <h2 className="mb-2 text-sm font-semibold text-ink-100">Como funciona</h2>
            <p>
              O envio usa o gateway Baileys já existente (multi-sessão). Cada empresa tem sua própria
              sessão — por padrão o identificador é o slug da empresa, e pode ser trocado em Configurações.
              As mensagens saem por um worker (cron chamando{' '}
              <code className="text-ink-300">/api/v1/jobs/run</code>), nunca durante a navegação do cliente.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
