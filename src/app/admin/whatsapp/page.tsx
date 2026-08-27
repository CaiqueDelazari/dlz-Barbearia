'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Send, XCircle } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';

type StatusResponse = {
  sessionId: string;
  status: { configured?: boolean; connected?: boolean; conectada?: boolean; error?: string } & Record<string, unknown>;
  connectUrl: string | null;
};

export default function WhatsappPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

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

            {!connected && data?.connectUrl && (
              <a
                href={data.connectUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-primary mt-4 w-full sm:w-auto"
              >
                <ExternalLink size={15} /> Abrir QR Code para parear
              </a>
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
