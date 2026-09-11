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

O seed cria um **estúdio de demonstração** — 14 serviços em 4 categorias (Cabelo,
Coloração, Tratamentos, Sobrancelha), 6 produtos de revenda com estoque, duas
profissionais e horário de terça a sábado:

| O quê | Onde |
|---|---|
| Página pública | `http://localhost:3000/agendar/estudio-demo` |
| Painel | `http://localhost:3000/login` |
| Login | o e-mail e a **senha sorteada** que o seed imprime ao rodar |

A senha é sorteada a cada execução e mostrada uma vez só — só o hash vai para o banco.
Para escolher a sua, `SEED_EMAIL` e `SEED_PASSWORD`. Nunca versione nenhuma das duas:
foi assim que se perdeu o painel de outro sistema da casa, com a senha no README.

Sem seed, crie a primeira empresa em `/cadastro` — nenhuma linha de código por cliente.

### Onde as tabelas moram

Por padrão em `public`. Num projeto Postgres compartilhado com outro sistema — o que é
comum aqui, porque o Supabase cobra por projeto — dê um schema só para esta instalação:

```env
DB_SCHEMA=barbearia        # SUPABASE_SCHEMA também é aceito
```

Vale para o app, o `db:migrate` e o `db:seed`. Duas instalações em `public` colidem na
primeira tabela de nome repetido, e `clients`, `payments` e `products` se repetem em
todo sistema da casa. O `db:migrate --reset` derruba **esse** schema, não o `public` —
e recusa rodar com `NODE_ENV=production`.

### Variáveis obrigatórias

```env
DATABASE_URL=postgresql://user:senha@host:5432/agenda?sslmode=require
JWT_SECRET=<48 bytes aleatórios>
APP_URL=http://localhost:3000
CRON_SECRET=<segredo para o worker>
```

Em produção, some a estas o `UPSTASH_REDIS_REST_URL` e o `UPSTASH_REDIS_REST_TOKEN` — sem
eles o rate limit conta por instância (detalhe na seção 12).

As demais (`WHATSAPP_*`, `PAYMENT_PROVIDER`) são opcionais — o sistema roda sem
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

**Vitrine na página pública.** A aba *Produtos*, ao lado das categorias de serviço, mostra o
que o estúdio revende — nome, marca e preço. É **mostruário, não loja**: não há botão de
adicionar, e foi decidido assim de propósito. Produto não tem duração e tem estoque, então
deixá-lo entrar no agendamento significaria segurar a prateleira por conta de uma reserva
que ainda pode expirar em 15 minutos — e um agendamento falso em série zeraria o estoque.
O cliente descobre que existe; a venda acontece no balcão, onde o estoque baixa de verdade.

A rota `/api/v1/public/{slug}/products` devolve uma lista curta de propósito: `cost_price`
é quanto o estúdio paga ao fornecedor e `stock_quantity` é o giro do negócio. Nenhum dos
dois sai. Tem teste garantindo que nenhum campo com `cost`, `stock` ou `track` no nome
escapa por ali.

**Venda avulsa** (painel → Produtos → *Venda avulsa*): o cliente que entra só para levar
um xampu e vai embora. Escolhe os produtos, a forma de pagamento e pronto — o cliente é
opcional, porque quem passa só para comprar costuma não estar cadastrado.

Ela **não vira agendamento**, e isso é a decisão que importa: um agendamento falso sujaria
a agenda, a contagem de faltas e o ticket médio por atendimento. A venda mora em
`product_sales` / `product_sale_items` e só encosta no resto em dois pontos — baixa o
estoque (com movimento, como qualquer saída) e grava uma linha paga em `payments`, que é
por onde o Financeiro lê todas as entradas. Por isso ela já aparece em *Entradas*, na
quebra por forma de pagamento e em *produtos vendidos*, sem nenhuma query nova.

*Cancelar* uma venda devolve o estoque e tira o valor do caixa, mas **mantém a linha
marcada como cancelada**: apagar esconderia o erro de digitação em vez de mostrá-lo.

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
A venda avulsa não tem essa ambiguidade: não há atendimento, então ela conta pela data da
venda nos dois lugares.

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
(configurável em Configurações → Sessão do WhatsApp). O valor **sempre** recebe o prefixo
`barb-` e é sanitizado: o bot é compartilhado com os outros sistemas da casa, e sem isso um
ADMIN que escrevesse a sessão de outra loja passaria a mandar mensagem saindo do WhatsApp
dela. Regressão coberta em `tests/whatsapp-sessao.test.ts`. O pareamento acontece **dentro do
painel** (`/admin/whatsapp`): o botão pede o QR ao bot pelas rotas `/api/sessoes`, e a
imagem é desenhada na própria tela.

Não use a página `/connect/<sessão>` do bot como link: fora do `/health`, toda rota dele
exige o `BOT_TOKEN`, e o navegador não manda header — o link abre em 401. O bot aceita
`?token=` para contornar, mas isso penduraria na URL o token que envia mensagem por todas
as lojas, onde ele vaza em histórico, log e Referer. Por isso a chamada sai do servidor.

### Quem recebe o quê

O cliente recebe confirmação, lembretes (24h e 1h), convite de retorno, aviso de
cancelamento e link de pagamento.

A **barbearia** recebe agendamento novo, cancelamento e remarcação, no número de
Configurações → *Número que recebe os avisos da loja* (em branco, não envia). São os três
eventos que mudam o dia de quem está no balcão — lembrete para a loja seria ruído, já que
a agenda está aberta na tela. Um agendamento com dois serviços no mesmo horário gera **um**
aviso, não dois: o texto já lista os serviços.

---

## 8. Pagamentos

`PaymentProvider` é uma interface. Hoje existem três:

- `manual` — checkout simulado, para desenvolver o fluxo inteiro sem gateway;
- `mercadopago` — Pix (QR + copia e cola) e cartão (Checkout Pro), com validação de
  assinatura `x-signature` e consulta na API antes de acreditar em qualquer status.

- `pagarme` — checkout hospedado para a conta Ton/Stone (Pix ou cartão), com
  consulta autenticada do pedido antes de confirmar o agendamento.

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
GET    /api/v1/public/{slug}/products                vitrine (sem custo nem estoque)
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
GET|POST         /api/v1/sales                       venda avulsa (balcão, sem agendamento)
GET|DELETE       /api/v1/sales/{id}                  detalhe | cancela e devolve ao estoque
GET|POST         /api/v1/expenses       DELETE /api/v1/expenses/{id}
GET|POST         /api/v1/blocks         DELETE /api/v1/blocks/{id}
GET              /api/v1/dashboard      GET /api/v1/financial/summary
GET|PATCH        /api/v1/settings
GET|PATCH        /api/v1/notifications/templates
GET|POST         /api/v1/notifications/send
GET              /api/v1/whatsapp/status
POST             /api/v1/whatsapp/connect        gera o QR de pareamento
GET|POST         /api/v1/jobs/run                  worker (cron)
```

Toda a lógica está na API — um app mobile futuro consome exatamente estes endpoints.

---

## 11. Domínio próprio (futuro)

Hoje: `agendaempresa.com.br/agendar/<slug>`. A tabela `tenants` já tem `custom_domain`
(único), então apontar `agenda.barbeariadojoao.com.br` para o tenant é resolver o host no
lugar do slug — sem mexer na estrutura.

---

## 12. Segurança

O que está feito, para não ter que redescobrir depois.

**Quem é quem.** Senha em bcrypt; access token JWT de 30 min em cookie `httpOnly`;
refresh token de valor aleatório, guardado como hash no banco e **rotacionado a cada uso**
(token usado é token queimado). Cookies `sameSite=lax` — o que já resolve CSRF nas rotas
que mudam estado. E-mail inexistente e senha errada devolvem a mesma mensagem **e demoram
o mesmo tempo** (um bcrypt descartável roda mesmo sem usuário), então a tela de login não
serve para descobrir quem tem conta.

**Uma empresa nunca vê a outra.** Toda tabela de negócio carrega `tenant_id` e toda query
filtra por ele; recurso carregado por id passa por `assertSameTenant` antes de voltar ou
mudar. Tem suíte de testes só para isso (`tests/e2e/seguranca.test.ts`).

**Papéis.** `OWNER > ADMIN > STAFF`. STAFF trabalha a agenda e vende no balcão; dinheiro
(Financeiro, despesas, cancelar venda) e configuração (serviços, produtos, ajustes) são de
ADMIN para cima. O dashboard **esconde faturamento, despesas, resultado e ticket médio de
quem é STAFF** — antes o Financeiro era bloqueado mas a página inicial entregava tudo.

**Segredos.** `.env` nunca foi versionado (só o `.env.example`). `npm run build` roda
`scripts/check-env.mjs` antes de compilar e **derruba o deploy** se o `JWT_SECRET` ainda
for o de exemplo, se ele for igual ao `CRON_SECRET`, se o banco estiver sem SSL, se a
`APP_URL` não for https ou se alguma integração estiver ligada pela metade. Como rede de
segurança, `src/lib/env.ts` também recusa segredo fraco em tempo de execução.

**Cabeçalhos.** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
`Permissions-Policy` e HSTS (só em produção) saem em toda resposta, configurados em
`next.config.mjs`. `X-Powered-By` foi removido.

**URL de imagem é buscada pelo servidor.** Logo, foto do profissional e foto do produto
ainda são URL colada à mão (o upload é pendência), e o otimizador do `next/image` vai
buscar esse endereço a partir da nossa infraestrutura. `imageUrlSchema` (`src/lib/security.ts`)
exige https e barra loopback, faixas privadas, `.local`/`.internal` e o endereço de
metadados da nuvem — que é justamente por onde um SSRF vira credencial vazada.

**O link do cliente.** O `manage_token` permite ver, remarcar e cancelar sem senha, então
`/api/v1/payments/{id}` — que é público, porque quem está pagando ainda não tem login —
**só entrega o token depois que o pagamento é confirmado**. O id é validado como uuid
antes de encostar no banco e a rota tem limite por IP.

**O worker.** `/api/v1/jobs/run` só aceita o segredo em `Authorization: Bearer`. A forma
antiga (`?secret=`) foi removida: query string entra em log de acesso, em Referer e no
histórico do navegador.

**Webhook de pagamento.** Assinatura conferida sobre o corpo cru, antes de qualquer parse;
evento repetido cai no `UNIQUE` de `payment_webhook_events` e não processa duas vezes.

**Erro nunca conta demais.** `handleError` registra o detalhe no log do servidor e devolve
mensagem genérica; nenhum `audit_log` guarda senha.

**Rate limit.** `rateLimit(chave, teto, janela)` conta as batidas por chave — `login:<ip>`,
`ai:<sessao>:<telefone>` — e devolve 429 ao estourar. Duas implementações atrás da mesma
função ([rate-limit.ts](src/lib/rate-limit.ts)): com `UPSTASH_REDIS_REST_URL` +
`UPSTASH_REDIS_REST_TOKEN` configurados, **todas as instâncias contam no mesmo lugar**;
sem eles, cai para um `Map` do processo. O incremento e o prazo de validade rodam num
script Lua, num passo só — em dois comandos existiria a janela em que a chave é criada e o
processo morre antes de marcar a validade, e aquele IP nunca mais conseguiria fazer login.
Redis fora do ar não derruba o agendamento: cai para a memória, avisa uma vez no log e
segue. O timeout é de 1s, para um Redis lento não virar uma página lenta.

O par no login merece atenção: **10 tentativas** em 5 min no geral, mas só **5 erradas**.
Quem sabe a senha nunca esbarra; quem está chutando esbarra rápido.

### O que ainda não está coberto
- **Next.js 14.2.35 tem avisos de segurança em aberto** que só somem no Next 16 (migração
  com quebra). Nenhum dos avisos aplicáveis atinge este app — não usamos Server Actions,
  i18n, rewrites nem nonce de CSP — e os que atingiam o otimizador de imagem foram fechados
  por configuração. Ainda assim, planejar a subida para o Next 16.
- **Sem 2FA e sem "esqueci minha senha"** (pendência 13).

---

## 13. Subir para produção

```bash
npm run check:env      # confere os segredos como se fosse produção
npm run test:all       # 28 unitários + 131 e2e (precisa do banco e do dev server)
npm run build          # o check:env roda de novo aqui, e barra o que estiver errado
npm run db:migrate     # no banco de produção
```

**Antes do primeiro deploy:**

1. Banco gerenciado criado, `DATABASE_URL` com `sslmode=require`.
2. `openssl rand -base64 48` para o `JWT_SECRET` e outro, **diferente**, para o
   `CRON_SECRET`. Cadastrar como variáveis do projeto — nunca em arquivo versionado.
3. `APP_URL` e `NEXT_PUBLIC_APP_URL` com o domínio https definitivo.
4. **Não** cadastrar `RATE_LIMIT_DISABLED`.
   Provisionar o Upstash Redis (`vercel integration add upstash`) — ele preenche as
   variáveis sozinho e o rate limit passa a valer o número que está escrito. O
   `check:env` avisa se faltar.
5. `npm run db:migrate` apontando para o banco de produção; conferir no log se o
   `btree_gist` subiu (é a trava de banco contra dois agendamentos no mesmo horário).
6. O cron de `vercel.json` roda a cada 5 min e o Vercel manda o `CRON_SECRET` sozinho.
7. Trocar a senha do usuário do seed, ou não rodar o seed em produção.
