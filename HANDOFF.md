# Handoff — estado em 02/09/2026

Quem pegar daqui: leia isto antes de mexer. O `PENDENCIAS.md` continua sendo a
lista de pendências; este arquivo é o retrato do que mudou nos últimos dias e o
porquê das decisões que **não devem ser desfeitas sem entender o motivo**.

---

## 1. Já está commitado — *atualizado em 03/09/2026*

Estava tudo na árvore de trabalho quando este arquivo nasceu. Foi para o remoto
depois, em duas levas: a remoção da IA, os avisos + pareamento e as correções de
segurança de uma vez; depois o Next 15, a imagem de produção e o cadastro do
Riady.

Autor a usar: `Caique Delazari <caiqueusc@hotmail.com>`.

> Cuidado com o que aconteceu aqui em 03/09: uma cópia local ficou com o mesmo
> trabalho **não commitado** enquanto o remoto já o tinha commitado, e ainda
> tinha o Next 15 e a imagem por cima. O push foi recusado, o que salvou o dia —
> `git fetch` antes de commitar teria economizado a confusão. Nada de force
> push nesse repositório: ele é escrito de mais de um lugar.

---

## 2. Banco: já está no ar

Supabase, projeto **`dlz-restaurantes`** (`levzbjfazivtgklbcphw`), schema
**`barbearia`**. O mesmo projeto hospeda quatro restaurantes, cada um no seu
schema — nada mora em `public`.

Estado conferido em 02/09/2026: **25 tabelas**, **7 migrations** registradas
(`001` a `007`), trava `excl_appt_overlap` **ativa** (o `btree_gist` sobe no
Supabase — era a dúvida do item 3 do PENDENCIAS), **0 tenants** e **0 usuários**.
A estrutura está pronta; não há dado nenhum.

### Como as migrations foram aplicadas — importante

Foram aplicadas **pelo MCP do Supabase**, não pelo `npm run db:migrate`, porque
a senha do banco não estava disponível. As linhas de `barbearia.schema_migrations`
foram inseridas junto, então um `db:migrate` futuro vê tudo como aplicado e não
repete nada.

Ao rodar a aplicação:

```
DB_SCHEMA=barbearia
DATABASE_URL=postgresql://postgres:<SENHA>@db.levzbjfazivtgklbcphw.supabase.co:5432/postgres
```

- **Migration** pela conexão direta (5432).
- **Aplicação** pelo pooler (6543) em **modo transaction** — o
  `pg_advisory_xact_lock` que segura o double booking depende disso. Esse caminho
  **ainda não foi exercitado**; é a única parte do item 3 que continua aberta.

---

## 3. As cinco correções de segurança

Todas seguem o mesmo padrão de defeito: **recurso compartilhado sem escopo de
tenant/usuário**. Se for mexer perto delas, entenda antes.

### 3.1 Sessão do WhatsApp presa a um namespace

O bot Baileys é **uma instância só** atendendo todos os negócios da casa
(`espeto-na-brasa`, etc.). O id da sessão é a única coisa que separa um número de
WhatsApp do outro lá dentro.

`business_settings.whatsapp_session_id` é editável por qualquer ADMIN e ia **cru**
para o `POST /send`. Quem escrevesse `espeto-na-brasa` passaria a mandar mensagem
**saindo do WhatsApp da Espetaria**, e a parear o próprio celular na sessão dela.

Corrigido em `whatsapp.service.ts`: prefixo obrigatório `barb-` + sanitização
(`safeSessionId`). Regressão em `tests/whatsapp-sessao.test.ts`.

> Qualquer sistema novo que use esse bot precisa do próprio prefixo.

### 3.2 Gateway de pagamento por loja, não por deploy

`PAYMENT_PROVIDER` é variável de ambiente — decisão por deploy, num sistema que
atende várias barbearias. As credenciais também vêm do ambiente, então a conta do
gateway é de **quem contratou a cobrança online**.

`online_payment_required` já era por loja e **nascia ligado**: toda loja nova
pedia pagamento online e o Pix do cliente dela cairia na conta de outra
barbearia. Sem erro em lugar nenhum.

Corrigido pela migration `007` + `getProviderForSettings()`:
`business_settings.payment_provider` nasce `'manual'`, e `online_payment_required`
nasce `false`.

> `payment_provider` **não** está na lista editável de `api/v1/settings/route.ts`,
> de propósito. É configuração de plataforma. Se alguém adicionar ali, o buraco
> volta com um clique em vez de um deploy.

Regressão em `tests/pagamento-por-loja.test.ts`.

### 3.3 Escopo de agenda por profissional

`GET /api/v1/appointments` usava `requireAuth` (qualquer papel) e passava só o
`tenantId`: um STAFF via a agenda do salão inteiro, com nome, telefone e valores
— e podia trocar `?professionalId=` para ler a agenda de um colega.

Criado `src/server/services/escopo.service.ts`:

- `ADMIN`/`OWNER` → `null` (vê tudo)
- `STAFF` vinculado → só o próprio `professional_id`
- `STAFF` **sem** vínculo → `''`, que vira um uuid inexistente e **não vê nada**

> O terceiro caso é deliberado. Devolver `null` para quem não tem vínculo abriria
> o salão inteiro justamente para o cadastro mal configurado.

Aplicado em: listagem de agendamentos, agenda (incluindo bloqueios e pausas),
detalhe do agendamento por id, lista de clientes e ficha do cliente por id —
filtrar a lista não basta quando o id abre o registro. Detalhes respondem **404**,
não 403, para não confirmar que o id existe.

A carteira de clientes é do salão: o barbeiro vê só quem já marcou com ele.

Regressão em `tests/escopo-agenda.test.ts`.

### 3.4 Corte de acesso imediato

`getSession` só conferia a assinatura do JWT. Com `JWT_ACCESS_TTL_MIN=30`,
desativar alguém só teria efeito **até meia hora depois**. O requisito do dono é
poder cortar um barbeiro na hora (caso de inadimplência).

`requireAuth` agora revalida `users.active` e `tenants.active` no banco a cada
requisição. Custa uma consulta por chave primária por request — é o preço de
poder desligar na hora.

> A rota de refresh já recusava usuário inativo; a janela era limitada, não
> infinita. Esta checagem a fecha de vez.

Dois níveis de corte: `professionals.active = false` tira da agenda mas mantém o
login; `users.active = false` corta o acesso inteiro.

### 3.5 Webhook do simulador aberto em produção — *03/09/2026*

Regressão da própria correção 3.2, encontrada depois. Antes dela o webhook usava
o provider global e comparava o nome: um deploy com `PAYMENT_PROVIDER=mercadopago`
recusava `/api/v1/payments/webhook/manual` porque não batia. Ao mover o gateway
para a loja, `getProviderByName` passou a devolver o `ManualProvider` **sempre**,
sem olhar o ambiente.

O `ManualProvider` é o simulador: o `parseWebhook` dele não confere assinatura
nenhuma — acredita no corpo do POST. Com um gateway de verdade ligado, o próprio
cliente abriria o checkout, pegaria o `paymentId` que a resposta devolve e daria

```
POST /api/v1/payments/webhook/manual
{"paymentId":"<o dele>","status":"paid","eventId":"x"}
```

confirmando o horário sem um centavo entrar. Nada a adivinhar.

Duas camadas fecham:

1. `getProviderByName` só entrega o `manual` fora de produção. Pagamento
   presencial não passa por webhook — vai por `registerManualPayment`, que exige
   sessão —, então produção não perde nada. Vale para preview da Vercel também,
   onde `NODE_ENV` já é `production`.
2. `handleWebhook` passou a buscar o pagamento por **id + provider**. Sem isso o
   id sozinho não diz de quem a cobrança é, e um webhook de um gateway quitaria
   a cobrança criada por outro.

> O `tests/pagamento-por-loja.test.ts` afirmava o comportamento errado como
> esperado (`getProviderByName('manual')` devolvendo provider com o deploy em
> mercadopago). O teste foi corrigido junto — é o tipo de linha que faz a
> próxima pessoa "consertar" de volta.

Hoje nada disso era explorável: as duas lojas estão em `manual` com
`online_payment_required = false`. Precisava estar fechado antes do primeiro
`payment_provider = 'pagarme'`.

---

## 4. O que mudou além da segurança

- **IA removida por completo**: `services/ai/`, rota `/api/v1/ai/chat`,
  `@anthropic-ai/sdk`, variáveis `AI_*`. A migration `005` derruba
  `whatsapp_conversations` e `whatsapp_messages`, que ficaram órfãs. O cliente
  quer o bot **avisando**, não respondendo.
- **Avisos para a barbearia** (migration `005`): agendamento novo, cancelamento e
  remarcação, no número de `owner_notify_phone`. Um aviso por agendamento, não um
  por serviço. Antes, os seis templates falavam só com o cliente.
- **Pareamento do WhatsApp pelo painel**: `POST /api/v1/whatsapp/connect` chama
  `/api/sessoes/:id/conectar` no bot e devolve o QR como data-URL.
  > Não volte a usar `/connect/<sessão>` como link: fora do `/health`, toda rota
  > do bot exige o `BOT_TOKEN`, e o navegador não manda header — dá 401. O bot
  > aceita `?token=`, mas isso penduraria na URL o token que envia mensagem por
  > todas as lojas.
- **`set_updated_at` com `search_path` fixo** (migration `006`), apontado pelo
  linter de segurança do Supabase.

---

## 5. O que falta

**Bloqueado em terceiros**

1. ~~Senha do banco~~ — **resolvido em 03/09/2026.** Foi criado o usuário
   `barbearia_app`, restrito ao schema `barbearia`, e a credencial vive no
   `.env` da VPS — não no repositório, não neste arquivo. A senha do `postgres`
   não foi tocada.
   > Na `DATABASE_URL` **não** use `sslmode=require`: o `pg` monta a própria
   > config de TLS a partir do parâmetro e passa a verificar a cadeia, o que dá
   > `SELF_SIGNED_CERT_IN_CHAIN` contra o pooler do Supabase. Use
   > `DATABASE_SSL=true`, que é o caminho do `db.ts` e liga
   > `rejectUnauthorized: false`. O `check:env` aceita as duas formas.
   > A ressalva que vem junto: `rejectUnauthorized: false` criptografa mas não
   > autentica o servidor. Para fechar de verdade, um dia, é fornecer o CA do
   > Supabase em vez de desligar a verificação.
2. **Credenciais Stone/Pagar.me** do Riady, o primeiro cliente.

**Fazível agora**

3. **Deploy — VPS, decidido em 03/09/2026.** A Vercel saiu da mesa: a conta é
   Hobby com 9 projetos comerciais, e no Hobby o cron roda **uma vez por dia** —
   com o worker parado, confirmação, lembrete de 24h, de 1h e aviso do dono
   deixam de sair, que é a razão de ser do sistema. O `vercel.json` continua no
   repositório e não atrapalha; fora da Vercel ele simplesmente não é lido.

   Já existe: `Dockerfile` multi-stage, `.dockerignore` e o workflow
   `build-image.yml`, que roda `tsc` + testes e publica
   `ghcr.io/caiquedelazari/dlz-barbearia:latest`. O build sai do GitHub Actions
   de propósito — com 2 vCPUs, compilar Next.js na VPS satura a máquina e deixa
   o Safra (que roda ao lado) arrastado. A VPS só baixa a imagem.

   Falta na VPS: `docker-compose`, o site no Caddy, e **um cron chamando
   `/api/v1/jobs/run`** com o `Authorization: Bearer $CRON_SECRET`. Sem esse
   último a fila enche e nenhuma mensagem sai — o sintoma é o pior tipo, tudo
   parece certo no painel e o cliente não recebe nada.
4. **`PagarmeProvider`.** Stone usa Pagar.me. O `MercadoPagoProvider` **não
   serve** — é escrever uma classe nova implementando `payment/provider.ts` (47
   linhas). Aceitar `'pagarme'` em `getProviderForSettings` e marcar só o Riady.
   > Webhook: a autenticação é *opcional* na Pagar.me. Exija Basic Auth **e**
   > consulte a API antes de acreditar no status, como o provider do Mercado Pago
   > já faz. Sem isso, quem descobrir a URL confirma horário sem dinheiro entrar.
5. **Tela para ligar/desligar barbeiro.** Hoje o vínculo `professionals.user_id`
   e o `users.active` só se mudam direto no banco. Falta um botão em
   Profissionais.
6. **ESLint.** `npm run lint` abre um assistente interativo — o projeto não tem
   config. **Nenhuma regra de lint roda hoje**, inclusive as de segurança do
   Next.
7. Item 5 do PENDENCIAS (data de "produtos vendidos") depende de decisão do dono.

---

## 6. Como verificar

```bash
npx tsc --noEmit     # limpo
npm test             # 64 testes, 0 falhas (5 pulados: Redis, sem container)
npm run build        # compila
# npm run lint       # NÃO funciona: sem config de ESLint
```

Os 5 pulados são de `tests/redis-compartilhado.test.ts`, que se pula sozinho sem
container — as instruções estão no cabeçalho do arquivo.

---

## 7. Contexto de produto

- **Riady** é o primeiro cliente. Vira o tenant de slug `riady`; a URL do
  agendamento é `{APP_URL}/agendar/riady`.
- Domínio por cliente (`tenants.custom_domain`) **não** está implementado — item
  11 do PENDENCIAS. Um domínio serve todas as lojas.
- Só o Riady terá cobrança online. Todas as outras lojas ficam em `manual`, que é
  pagamento no balcão — e isso é o padrão desde a migration `007`.
