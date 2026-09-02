# Handoff — estado em 02/09/2026

Quem pegar daqui: leia isto antes de mexer. O `PENDENCIAS.md` continua sendo a
lista de pendências; este arquivo é o retrato do que mudou nos últimos dias e o
porquê das decisões que **não devem ser desfeitas sem entender o motivo**.

---

## 1. Nada disto está commitado

O último commit é `544d951`. Há **36 arquivos** modificados/novos na árvore de
trabalho, e o repositório remoto (`CaiqueDelazari/dlz-Barbearia`) está
desatualizado.

Sugestão de divisão, se for commitar:

1. Remoção da IA
2. Avisos para a barbearia + pareamento do WhatsApp pelo painel
3. **Correções de segurança** — vale um commit próprio; são quatro, descritas
   abaixo, e é bom que apareçam sozinhas no histórico

Autor a usar: `Caique Delazari <caiqueusc@hotmail.com>`.

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

## 3. As quatro correções de segurança

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

1. **Senha do banco** — sem ela a aplicação não sobe (o `check:env` derruba o
   build antes do `next build`).
2. **Credenciais Stone/Pagar.me** do Riady, o primeiro cliente.

**Fazível agora**

3. **Deploy.** O projeto **nunca foi publicado**. Não existe `.vercel/`. Duas
   opções em aberto: VPS Hostinger KVM 2 já paga (2 vCPU, 8 GB, Ubuntu 24.04,
   Docker + Caddy, IP `187.127.62.147`) ou Vercel — cuja conta é **Hobby com 9
   projetos comerciais**, o que é risco de suspensão.
   > Se for a VPS: tire o `docker compose build` de lá. Com 2 vCPUs, compilar
   > Next.js satura a máquina e deixa o Safra (que roda ao lado) arrastado.
   > Build no GitHub Actions, VPS só baixa a imagem.
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
npm test             # 57 testes, 0 falhas (5 pulados: Redis, sem container)
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
