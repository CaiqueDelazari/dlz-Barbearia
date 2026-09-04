'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Loader2, RotateCcw, Save, Send } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { formatDateTimeBR } from '@/lib/format';

type Template = { key: string; body: string; enabled: boolean; isDefault: boolean; defaultBody: string };

type Notification = {
  id: string;
  type: string;
  toPhone: string;
  body: string;
  status: string;
  scheduledFor: string;
  sentAt: string | null;
  error: string | null;
  clientName: string | null;
};

const TEMPLATE_LABEL: Record<string, string> = {
  confirmation: 'Confirmação do agendamento',
  reminder_24h: 'Lembrete 24 horas antes',
  reminder_1h: 'Lembrete 1 hora antes',
  return: 'Convite de retorno',
  cancelled: 'Aviso de cancelamento',
  payment_link: 'Link de pagamento',
  owner_new: 'Para a loja: agendamento novo',
  owner_cancelled: 'Para a loja: cancelamento',
  owner_rescheduled: 'Para a loja: remarcação',
  welcome: 'Resposta automática de boas-vindas',
};

/** Explicação de quando cada mensagem sai — o título não diz o suficiente. */
const TEMPLATE_HINT: Record<string, string> = {
  owner_new: 'Vai para o telefone de avisos, não para o cliente.',
  owner_cancelled: 'Vai para o telefone de avisos, não para o cliente.',
  owner_rescheduled: 'Vai para o telefone de avisos, não para o cliente.',
  welcome:
    'Sai sozinha quando alguém manda mensagem no WhatsApp da loja, uma vez a ' +
    'cada 6 horas por contato. Só aceita {empresa} e {link_agendamento} — ' +
    'quando ela sai, ainda não existe agendamento nenhum.',
};

const STATUS_CLASS: Record<string, string> = {
  scheduled: 'text-ink-400',
  sending: 'bg-state-warn/10 text-state-warn',
  sent: 'bg-brand-500/10 text-brand-500',
  failed: 'bg-state-bad/10 text-state-bad',
  skipped: 'text-ink-400',
  cancelled: 'text-ink-500',
};

export default function NotificacoesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [queue, setQueue] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, q] = await Promise.all([
        api.get<{ templates: Template[]; variaveis: string[] }>('/notifications/templates'),
        api.get<{ notifications: Notification[] }>('/notifications/send'),
      ]);
      setTemplates(t.templates);
      setVariables(t.variaveis);
      setQueue(q.notifications);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api.patch('/notifications/templates', {
        templates: templates.map((t) => ({ key: t.key, body: t.body, enabled: t.enabled })),
      });
      toast.success('Mensagens salvas');
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Notificações</h1>
          <p className="text-sm text-ink-400">Mensagens automáticas enviadas pelo WhatsApp</p>
        </div>
        <button type="button" disabled={saving} onClick={save} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Salvar mensagens
        </button>
      </header>

      {loading ? (
        <div className="flex justify-center py-16 text-ink-500">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <>
          <p className="card p-4 text-xs text-ink-400">
            Variáveis disponíveis:{' '}
            {variables.map((v) => (
              <code key={v} className="mr-1.5 rounded bg-ink-850 px-1.5 py-0.5 text-brand-500">
                {`{${v}}`}
              </code>
            ))}
          </p>

          <section className="space-y-3">
            {templates.map((template, index) => (
              <article key={template.key} className="card p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-ink-100">
                    {TEMPLATE_LABEL[template.key] ?? template.key}
                  </span>
                  <label className="flex items-center gap-2 text-xs text-ink-400">
                    <input
                      type="checkbox"
                      checked={template.enabled}
                      onChange={(e) => {
                        const next = [...templates];
                        next[index] = { ...template, enabled: e.target.checked };
                        setTemplates(next);
                      }}
                      className="h-4 w-4 accent-brand-500"
                    />
                    Ativa
                  </label>
                </div>

                {TEMPLATE_HINT[template.key] && (
                  <p className="mb-2 text-xs text-ink-500">{TEMPLATE_HINT[template.key]}</p>
                )}

                <textarea
                  className="input h-28 resize-y text-sm"
                  value={template.body}
                  onChange={(e) => {
                    const next = [...templates];
                    next[index] = { ...template, body: e.target.value };
                    setTemplates(next);
                  }}
                />

                <button
                  type="button"
                  onClick={() => {
                    const next = [...templates];
                    next[index] = { ...template, body: template.defaultBody };
                    setTemplates(next);
                  }}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-100"
                >
                  <RotateCcw size={12} /> Restaurar texto padrão
                </button>
              </article>
            ))}
          </section>

          <section className="card">
            <h2 className="flex items-center gap-2 border-b border-ink-800 px-5 py-4 text-sm font-semibold text-ink-100">
              <Send size={15} className="text-ink-500" /> Fila de envio
            </h2>
            {queue.length ? (
              <ul className="divide-y divide-ink-800">
                {queue.slice(0, 40).map((item) => (
                  <li key={item.id} className="flex items-start gap-3 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-100">
                        {item.clientName ?? item.toPhone}
                        <span className="ml-2 text-xs text-ink-500">{item.type}</span>
                      </span>
                      <span className="block truncate text-xs text-ink-500">{item.body}</span>
                      {item.error && <span className="block text-xs text-state-bad">{item.error}</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={clsx('badge', STATUS_CLASS[item.status] ?? STATUS_CLASS.scheduled)}>
                        {item.status}
                      </span>
                      <span className="mt-1 block text-[11px] text-ink-500">
                        {formatDateTimeBR(item.sentAt ?? item.scheduledFor)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-ink-500">Nenhuma mensagem na fila.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
