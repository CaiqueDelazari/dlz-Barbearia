# Agenda SaaS — agendamento para barbearias e salões

Sistema **multi-tenant** de agendamento online. Uma instalação atende quantas empresas
quiser: cada uma com seus serviços, profissionais, horários, clientes, pagamentos,
mensagens e financeiro — isolados entre si.

```
Frontend (Next.js)  →  API REST /api/v1  →  Serviços de domínio  →  PostgreSQL
                                          ↘  Gateway de pagamento (webhook)
                                          ↘  WhatsApp (bot Baileys) + IA
```

---

## 1. Subir o projeto

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL e JWT_SECRET
npm run db:migrate            # cria o schema
npm run db:seed               # empresa de demonstração (opcional)
npm run dev
```

O seed cria o **Estúdio Duda Machado** — 14 serviços em 4 categorias (Cabelo, Coloração,
Tratamentos, Sobrancelha), 6 produtos de revenda com estoque, duas profissionais e horário
de terça a sábado:

| O quê | Onde |
|---|---|
| Página pública | `http://localhost:3000/agendar/duda-machado` |
| Painel | `http://localhost:3000/login` |
| Login | `duda@dudamachado.com.br` / `dudamachado` |

Sem seed, crie a primeira empresa em `/cadastro` — nenhuma linha de código por cliente.

### Variáveis obrigatórias

```env
DATABASE_URL=postgresql://user:senha@host:5432/agenda?sslmode=require
JWT_SECRET=<48 bytes aleatórios>
APP_URL=http://localhost:3000
CRON_SECRET=<segredo para o worker>
```

As demais (`WHATSAPP_*`, `PAYMENT_PROVIDER`, `AI_*`) são opcionais — o sistema roda sem
elas e degrada com elegância: mensagens ficam na fila com status `skipped` e o pagamento
usa o provider `manual` (checkout simulado em `/pagamento/simulado/<id>`).

---

## 2. Como o sistema está organizado

```
database/migrations/     schema versionado (SQL puro, roda uma vez cada)
src/lib/                 db, auth, http, datetime, format   (infra)
src/server/
  repositories/          acesso a dados por tenant
  services/              REGRAS DE NEGÓCIO
    availability.service.ts   ← cálculo de horários livres
    appointment.service.ts    ← criação, remarcação, cancelamento
    product.service.ts        ← venda no atendimento + estoque
    payment/                  ← PaymentProvider + gateways
    notification.service.ts   ← fila de mensagens
    whatsapp.service.ts       ← integração isolada com o bot
    ai/                       ← atendente com ferramentas
src/app/api/v1/          rotas REST (finas: validam, chamam serviço, respondem)
src/app/agendar/[slug]/  fluxo público do cliente
src/app/admin/           painel
```

Rota nunca contém regra de negócio; serviço nunca conhece HTTP.

---

## 3. Decisões que sustentam o sistema

**Isolamento entre empresas.** Toda tabela de negócio tem `tenant_id`, toda query filtra
por ele, e o `tenant_id` vem do JWT — nunca do corpo da requisição. Um usuário não
consegue alcançar dado de outra empresa nem trocando ids na URL.

**Double booking é impossível por construção.** Três camadas:
1. a disponibilidade já esconde o horário ocupado;
2. na criação, `pg_advisory_xact_lock(tenant:profissional)` serializa os concorrentes e
   revalida o intervalo dentro da transação;
3. o banco tem `EXCLUDE USING gist` sobre `(professional_id, período)` — se algo escapar
   das duas primeiras, o Postgres recusa.

**Duração real, não “30 minutos”.** Cada serviço tem sua duração. Selecionar Corte (30) +
Barba (30) reserva 14:00→15:00 inteiro. Se não houver bloco contínuo, o sistema oferece
horários separados e amarra os agendamentos pelo mesmo `booking_group_id`.

**Pagamento só o webhook confirma.** A reserva nasce `pending` com `hold_expires_at`. O
frontend nunca confirma nada. Cada evento de webhook entra em `payment_webhook_events`
com `UNIQUE (provider, external_id)` — reenvio do gateway não processa duas vezes. Não
pagou no prazo? O job devolve o horário para a agenda.

**Nada de regra fixa no código.** Intervalo da grade, antecedência mínima, janela de
remarcação, percentual do sinal, tempo de reserva, dias para o convite de retorno, textos
das mensagens — tudo em `business_settings` / `notification_templates`, editável no painel.

**Fuso por empresa.** Instantes são `timestamptz`; o que o cliente vê é convertido para o
fuso da empresa via `Intl` (sem dependência externa, respeita horário de verão).

---

## 4. Fluxo do cliente

```
/agendar/<slug>
  abas por categoria        →  Cabelo · Coloração · Tratamentos · Sobrancelha
  escolhe serviços (multi)  →  soma preço e duração
  escolhe profissional      →  opcional, se a empresa permitir
  calendário                →  só dias com vaga real
  horário                   →  só encaixes que cabem na duração total
  nome + telefone           →  sem conta, sem senha, sem e-mail
  pagamento 50% ou 100%     →  Pix ou cartão
  confirmação               →  link seguro para ver/remarcar/cancelar
```

O link de gerenciamento (`/agendamento/<token>`) tem token opaco e prazo de validade,
e respeita a janela mínima de remarcação configurada.

---

## 4.1 Identidade visual

Paleta neutra quente, sem cor de destaque gritante — o "acento" é a luz:

| Token | Hex | Uso |
|---|---|---|
| `ink-950` | `#0e0d0c` | fundo (preto quente, não azulado) |
| `ink-900/850` | `#141312` / `#171614` | superfícies |
| `ink-800` | `#232120` | hairlines — substituem quase toda borda |
| `bone` | `#ede8e0` | texto forte e botão primário |
| `ink-300/400` | `#a79e93` / `#8a8279` | texto secundário e terciário |
| `brand` | `#c2ae93` | champanhe dessaturado: só seleção e ênfase |

Status usam croma baixo de propósito (`state-ok` sage, `state-warn` areia, `state-bad`
tijolo) para não competir com o conteúdo.

Tipografia: **Cormorant Garamond** (leve, espaçada) só onde a marca fala — nome do
estúdio, títulos de etapa; **DM Sans** conduz a interface. Horários e valores usam
numerais tabulares, senão a lista "dança" a cada troca de dígito.

**Elemento de assinatura — a barra de duração.** Ao escolher o horário, aparece uma
hairline com dois ticks: `14:00 ——— 15:00 · 1h reservados`. É a regra que mais gera
dúvida ("por que 14:30 sumiu?") desenhada em vez de explicada.

Categorias de serviço viram abas na página pública automaticamente. O campo fica em
Serviços → Categoria no painel (com sugestão das já usadas); serviço sem categoria cai em
"Outros", e com uma categoria só as abas nem aparecem.

---

## 4.2 Fechar a agenda

O caso mais comum do dia a dia, então tem tela própria (Agenda → **Fechar agenda**) montada
em cima do que realmente acontece:

| Situação | Como se faz |
|---|---|
| "Saio mais cedo hoje" | Hoje → **Resto do dia** (parte do horário atual, arredondado) |
| "Chego tarde amanhã" | Amanhã → **Manhã** |
| "Dentista terça 15h" | data → **Escolher horário** → 15:00 às 16:30 |
| "Feriado" | data → **Dia inteiro** → motivo *Feriado* |
| "Férias de 10 a 20" | data inicial + data final → **Dia inteiro** |
| "Larissa não atende segunda de manhã" | horário + **Repetir toda segunda** (vira pausa fixa) |
| "Fechei errado" | botão de reabrir na própria linha da agenda |

**Manhã** e **Tarde** saem do horário de funcionamento real daquele dia, não de um 12:00
chutado. **Fechar para quem** permite bloquear só um profissional — o resto da equipe segue
atendendo.

**A regra que protege o cliente:** se já houver alguém marcado no período, o sistema
**recusa** e mostra quem é, com telefone e link de WhatsApp. Aí você escolhe:

- *Manter os agendamentos e fechar o resto* — impede novos, quem está marcado continua;
- *Cancelar e fechar* — cancela e dispara a mensagem de cancelamento para cada cliente.

Nunca existe o caminho "fechou e sumiu com o cliente calado".

A agenda mostra o dia como ele é: atendimentos, bloqueios (tracejados, com botão de
reabrir), pausas fixas da semana e o expediente no cabeçalho — dia sem expediente aparece
como *Sem expediente* em vez de tela vazia.

**Pausas somam, expediente substitui.** Se o profissional tem horário próprio, ele
substitui o da empresa; mas a pausa pessoal dele **soma** com o almoço da casa — do
contrário uma folga individual reabriria um horário em que o estúdio está fechado. Há teste
de regressão para isso.

---

## 4.3 Produtos e estoque

Salão vende xampu, máscara e óleo junto com o atendimento — então o produto mora no mesmo
fluxo do dinheiro, não numa ilha.

**Aba Produtos** (painel → Produtos): cadastro com preço de venda, quanto você paga, marca,
categoria e controle de estoque opcional. O cabeçalho mostra itens ativos, valor parado em
estoque (a custo) e quantos precisam de reposição. A margem por unidade aparece enquanto
você digita, e avisa se o preço ficou abaixo do custo.

**Venda no atendimento**: abrindo um horário na agenda há a seção *Produtos* → *Vender
produto*. Ao lançar:

1. o valor entra no total daquele atendimento (o "falta pagar" já se ajusta sozinho);
2. o estoque baixa;
3. o movimento fica registrado.

Sem estoque, o sistema **recusa e diz quanto sobrou** — não vende o que não existe.
Removeu a venda? Volta para o estoque e sai do total.

**Estoque** tem três operações, com nomes de gente: *Entrada* (chegou mercadoria),
*Contagem* (corrige para o número real que você contou) e *Perda* (quebrou, venceu, sumiu).
Toda mexida vira linha em `product_movements` — venda, entrada, ajuste e devolução — porque
"sumiu um xampu" precisa ter resposta.

---

## 4.4 Despesas no dashboard

Despesa se lança no calor do dia, então o botão está onde a pessoa já está: **Dashboard →
Despesa**. O mesmo formulário do Financeiro, com categorias de um toque (Produtos, Aluguel,
Energia, Água, Internet, Salário, Impostos, Marketing).

O dashboard mostra o total do período, as últimas cinco lançadas e um card de estoque
avisando o que precisa repor. O Financeiro segue com a visão completa e a quebra por
produto vendido.

**Duas datas diferentes, de propósito:** *Entradas* segue a data do pagamento (caixa);
*produtos vendidos* e *serviços realizados* seguem a data do atendimento (agenda). Um
produto vendido hoje num horário da semana que vem aparece no caixa hoje e na agenda lá.

---

## 5. Painel

Dashboard · Agenda (dia/semana) · Agendamentos · Clientes · Serviços · **Produtos** ·
Profissionais · Financeiro · Relatórios · Notificações · WhatsApp · Configurações.

Inclui agendamento manual (balcão), bloqueio de horários/folgas/férias, registro de
pagamento presencial, controle de quanto foi pago e quanto falta, ficha do cliente com
histórico e despesas com resultado mensal.

---

## 6. Jobs automáticos

Um worker único, chamado por cron — nunca pela navegação do cliente:

```
POST /api/v1/jobs/run     Authorization: Bearer $CRON_SECRET
```

Faz: expira reservas não pagas · cria convites de retorno · envia a fila de mensagens
(confirmação, lembrete 24h, lembrete 1h).

Em produção na Vercel, `vercel.json` já agenda de 5 em 5 minutos. Em servidor próprio:

```cron
*/5 * * * * node scripts/run-jobs.mjs
```

---

## 7. WhatsApp — reaproveitando o bot existente

O envio usa o **bot Baileys que você já tem** (`Bot-Whats`), que é multi-sessão:

```env
WHATSAPP_ENABLED=true
WHATSAPP_API_URL=http://localhost:3001
WHATSAPP_TOKEN=<o mesmo BOT_TOKEN do bot>
```

Cada empresa usa uma sessão do bot; por padrão o identificador é o slug da empresa
(configurável em Configurações → Sessão do WhatsApp). O pareamento por QR Code é feito
pelo próprio bot — o painel (`/admin/whatsapp`) mostra o status e o link.

### Atendimento por IA (opcional)

Para o bot responder clientes, basta ele encaminhar as mensagens recebidas:

```js
// no Bot-Whats, ao receber mensagem de texto
const res = await fetch(`${SITE_URL}/api/v1/ai/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
  body: JSON.stringify({ session: sessionId, phone, message: texto }),
});
const { data } = await res.json();
await sock.sendMessage(jid, { text: data.reply });
```

A IA **não escreve no banco**. Ela usa ferramentas (`get_services`,
`get_available_slots`, `create_appointment`, `reschedule_appointment`,
`cancel_appointment`, …) que chamam a mesma camada de serviço da API — então respeitam
disponibilidade real, trava de concorrência e política de cancelamento. Se ela inventar
um horário, o backend recusa.

---

## 8. Pagamentos

`PaymentProvider` é uma interface. Hoje existem dois:

- `manual` — checkout simulado, para desenvolver o fluxo inteiro sem gateway;
- `mercadopago` — Pix (QR + copia e cola) e cartão (Checkout Pro), com validação de
  assinatura `x-signature` e consulta na API antes de acreditar em qualquer status.

Trocar de gateway = uma classe nova em `services/payment/providers/` + mudar
`PAYMENT_PROVIDER`. Nenhuma regra de negócio muda.

---

## 9. Testes

```bash
npm test        # 20 testes de unidade — não precisam de banco nem servidor
npm run test:e2e   # 110 testes de ponta a ponta — precisam do banco e do `npm run dev`
npm run test:all   # tudo
```

**Unidade** (`tests/*.test.ts`) — a matemática da agenda e o limitador de requisições,
rodando sobre funções puras: conversão de fuso, grade de horários, almoço, bloqueios,
duração combinada exigindo slots consecutivos, antecedência mínima, horário próprio do
profissional, soma de pausas, e a trava que impede desligar o rate limit em produção.

**Ponta a ponta** (`tests/e2e/*.test.ts`) — falam HTTP com o servidor de verdade, contra o
banco de verdade. Cada arquivo **cria a própria empresa e a apaga no fim**, então não
dependem do seed, não sujam a demonstração e rodam em paralelo:

| Arquivo | Cobre |
|---|---|
| `agendamento` | página pública, categorias, disponibilidade, bloco da combinação, double booking, corrida de 5 pedidos simultâneos, agenda por profissional |
| `pagamentos` | reserva temporária, sinal, webhook idempotente, pagamento recusado, pagamento presencial parcelado, link do cliente (remarcar/cancelar/janela mínima), expiração pelo worker |
| `fechar-agenda` | bloqueio pontual, dia inteiro, férias, folga de um profissional, pausa fixa semanal, e as três saídas quando há cliente marcado (recusar/manter/cancelar) |
| `produtos` | catálogo, venda no atendimento, estoque negativo recusado, desfazer venda, saldo devedor, entrada/contagem/perda, histórico de movimento |
| `seguranca` | isolamento entre duas empresas em 8 frentes, autenticação, papéis OWNER/ADMIN/STAFF, validação de entrada, segredo do worker |
| `financeiro` | despesas, cards do dashboard, resumo por forma de pagamento e categoria, ficha do cliente, fila de notificações, relatórios |

Os e2e exigem `DATABASE_URL` e `CRON_SECRET` no `.env` e o servidor em pé. Como a suíte
dispara muitas reservas seguidas, o `.env` de desenvolvimento traz
`RATE_LIMIT_DISABLED=true` — **ignorado quando `NODE_ENV=production`**, com teste próprio
garantindo que a variável não abre a porteira em produção.

## 10. API (resumo)

```
POST   /api/v1/signup                              cria empresa + dono
POST   /api/v1/auth/login | refresh | logout
GET    /api/v1/auth/me

GET    /api/v1/public/{slug}                       dados da página
GET    /api/v1/public/{slug}/services
GET    /api/v1/public/{slug}/professionals
GET    /api/v1/public/{slug}/availability?date=|month=&services=
POST   /api/v1/public/{slug}/appointments          cria a reserva
GET|PATCH|DELETE /api/v1/public/booking/{token}    cliente vê/remarca/cancela

POST   /api/v1/payments/checkout                   gera a cobrança
POST   /api/v1/payments/webhook/{provider}         confirma (idempotente)
GET    /api/v1/payments/{id}

GET|POST         /api/v1/appointments              lista | agendamento manual
GET|PATCH|DELETE /api/v1/appointments/{id}
GET|POST         /api/v1/appointments/{id}/payments
GET              /api/v1/agenda?date=&view=day|week|month
GET|POST         /api/v1/clients        GET|PATCH /api/v1/clients/{id}
GET|POST         /api/v1/services       PATCH|DELETE /api/v1/services/{id}
GET|POST         /api/v1/professionals  PATCH|DELETE /api/v1/professionals/{id}
GET|POST         /api/v1/products       GET|PATCH|DELETE /api/v1/products/{id}
POST             /api/v1/products/{id}/stock        entrada, contagem, perda
GET|POST|DELETE  /api/v1/appointments/{id}/products vende/desfaz produto no atendimento
GET|POST         /api/v1/expenses       DELETE /api/v1/expenses/{id}
GET|POST         /api/v1/blocks         DELETE /api/v1/blocks/{id}
GET              /api/v1/dashboard      GET /api/v1/financial/summary
GET|PATCH        /api/v1/settings
GET|PATCH        /api/v1/notifications/templates
GET|POST         /api/v1/notifications/send
GET              /api/v1/whatsapp/status
POST             /api/v1/ai/chat                   entrada do bot
GET|POST         /api/v1/jobs/run                  worker (cron)
```

Toda a lógica está na API — um app mobile futuro consome exatamente estes endpoints.

---

## 11. Domínio próprio (futuro)

Hoje: `agendaempresa.com.br/agendar/<slug>`. A tabela `tenants` já tem `custom_domain`
(único), então apontar `agenda.barbeariadojoao.com.br` para o tenant é resolver o host no
lugar do slug — sem mexer na estrutura.
