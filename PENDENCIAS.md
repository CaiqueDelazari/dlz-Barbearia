# Pendências

O que ficou em aberto, com o porquê. Ordenado por prioridade — o topo é o que mais
atrapalha o dia a dia ou mais assusta em produção.

Legenda: **falta** = funcionalidade que não existe · **decisão** = está funcionando, mas
o comportamento precisa de confirmação · **risco** = funciona hoje e quebra ao crescer ·
**não verificado** = escrito, nunca exercitado de verdade.

---

## Alta

### 1. Gateway de pagamento: falta escrever o provider da Pagar.me — *falta*
O cliente usa **Stone**, então o gateway é **Pagar.me** (mesma casa). O
`MercadoPagoProvider` não serve e não vale adaptar — é escrever um `PagarmeProvider` ao
lado, implementando a mesma interface de `payment/provider.ts` (47 linhas: checkout, Pix,
webhook assinado, consulta antes de acreditar no status).

Quando for escrever: o webhook agora busca o pagamento por **id + provider**, e o nome
precisa entrar em `getProviderByName` para o endpoint existir. O `manual` só é aceito fora
de produção — é simulador, não gateway (ver §3.5 do HANDOFF).

Até as chaves da Stone existirem, `PAYMENT_PROVIDER=manual` continua sendo a configuração
correta. Lembrando a distinção de sempre: **maquininha não é integração**. Pagamento no
balcão se registra como `card` e já funciona. O gateway online só entra para cobrar o
**sinal pela internet**, antes de o cliente vir.

### 2. O bot nunca enviou uma mensagem de verdade — *não verificado*
A fila funciona e está testada, e o contrato com o Bot-Whats foi conferido campo a campo
(`POST /send {session, phone, message}`, `Bearer` do `BOT_TOKEN`, `/status/:id`) — bate.
Falta parear a sessão da barbearia e ver uma mensagem sair. Com o gateway desligado elas
terminam como `skipped`.

Dois furos nos avisos da loja foram fechados em 03/09/2026: em horários separados o dono
recebia aviso só do primeiro item (marcou corte 14h + barba 16h, ele via só 14h), e no
caminho com pagamento online — onde o agendamento nasce `pending` e só confirma no
webhook — ele não recebia aviso nenhum. Este segundo só apareceria no dia em que a
Pagar.me entrasse.

O **atendimento por IA saiu do produto** (31/08/2026): o cliente quer o bot avisando, não
respondendo. Foram removidos `services/ai/`, a rota `/api/v1/ai/chat`, o
`@anthropic-ai/sdk` e as variáveis `AI_*`; a migration `005` derruba as duas tabelas de
conversa que sobraram.

Os avisos **para a barbearia** passaram a existir na mesma leva — antes todos os seis
templates falavam só com o cliente.

### 3. ~~Migrations nunca rodaram em Postgres gerenciado~~ — **resolvido em 31/08/2026**
Rodaram no Supabase (`dlz-restaurantes`, schema `barbearia`), e as duas dúvidas do item
original foram respondidas na prática:

- **`btree_gist` subiu.** A trava `excl_appt_overlap` existe e está ativa — conferido com
  `SELECT conname FROM pg_constraint WHERE conname = 'excl_appt_overlap'`. O double booking
  tem as duas camadas, não só o lock da aplicação.
- **Extensões no schema `extensions`.** Criadas lá de propósito (`pgcrypto`, `btree_gist`),
  e o `search_path` do app já inclui `public` e `extensions` no fim do caminho.

Resultado: 25 tabelas, 7 enums, 6 migrations registradas em `schema_migrations`. Os quatro
restaurantes que dividem o banco ficaram intactos e o `public` continua vazio.

Falta ainda o **PgBouncer em modo transaction**: o `pg_advisory_xact_lock` depende disso, e
só dá para confirmar quando a aplicação subir apontando para o pooler (porta 6543). A
migration foi pela conexão direta, que é o certo para DDL mas não exercita esse caminho.

## Média

### 4. ~~Next.js 14 tem avisos de segurança sem correção no 14.x~~ — **resolvido em 03/09/2026**

Subiu para o **Next 15.5.24** e as rotas dinâmicas foram adaptadas (`params`
virou assíncrono). O que está abaixo fica como registro do porquê da subida.


`npm audit` acusa 2 severidades altas em `next@14.2.35` (a última do 14.x) e em `postcss`.
O intervalo dos avisos vai até 16.3.0-preview.10: **não existe patch no 14.x**, só a
migração para o Next 16, que quebra APIs (`params` virou assíncrono no 15).

Avaliado item a item, nenhum dos avisos aplicáveis atinge este app — não há Server
Actions, i18n, rewrites, WebSocket upgrade nem nonce de CSP. Os que atingiam o otimizador
de imagem foram fechados por configuração (`dangerouslyAllowSVG: false`,
`contentDispositionType: attachment`, CSP própria do endpoint) e pela validação de URL.

Ainda assim é dívida real e datada: planejar a subida para o Next 16 como trabalho
próprio, com a suíte e2e servindo de rede.

### 5. Data de "produtos vendidos" — *decisão*
Produto vendido **dentro do atendimento** segue a **data do atendimento** (igual a
"serviços realizados"), enquanto *Entradas* segue a **data do pagamento**. Um produto
vendido hoje, num horário da semana que vem, aparece no caixa hoje e na quebra de produtos
lá. (A venda avulsa não tem essa ambiguidade — sem atendimento, conta pela data da venda.)

É coerente e está explicado na tela, mas se o esperado for "produto conta no dia em que
saiu da prateleira", é trocar `a.starts_at` por `ap.created_at` em `dashboard.service.ts`
(nos dois `UNION`, só no ramo de `appointment_products`).

---

## Baixa

### 9. Feriados nacionais — *falta*
Fechar em feriado é manual. Pré-carregar os nacionais seria conveniente, mas varia por
cidade/estado e viraria regra fixa no código — precisaria vir de configuração ou de uma
tabela por tenant.

### 11. Domínio próprio — *falta*
`tenants.custom_domain` existe e é único, mas a resolução por host não foi implementada —
hoje o tenant sai sempre do slug na URL.

### 12. Upload de imagem — *falta*
Logo, foto de profissional e imagem de serviço/produto só aceitam URL. Falta upload
(Vercel Blob ou storage do Supabase).

### 13. Recuperação de senha — *falta*
Não há "esqueci minha senha". Hoje só resolve mexendo no banco.

### 14. Catálogo de produtos carrega inteiro — *risco*
`/api/v1/products` devolve tudo, sem `limit`. Nada é cortado em silêncio (o problema das
outras listas), e a tela agrupa por categoria e filtra no cliente — o que só funciona com
o catálogo completo em mãos. Para um salão são dezenas de itens; se um dia virar milhares,
aí sim precisa paginar e mover a busca para o servidor.

---

## Já resolvido (para não reabrir)

- **O sistema pode morar num schema próprio** (`DB_SCHEMA`, ou `SUPABASE_SCHEMA`, o nome
  que os outros projetos da casa já usam). Sem a variável é `public` e nada muda, então
  quem já subiu não sente. Existe porque um projeto Supabase costuma hospedar mais de um
  sistema — o Supabase cobra por projeto — e duas instalações em `public` colidem na
  primeira tabela de nome repetido: `clients`, `payments` e `products` se repetem em todos.
  O `search_path` é aplicado **em cada conexão nova** do pool, não uma vez: o pool abre e
  fecha conexões ao longo da vida do processo, e uma aberta depois nasceria em `public` —
  o sintoma seria dos piores, funcionar no começo e passar a dar "relation does not exist"
  quando o pool cresce. `public` e `extensions` ficam no fim do caminho porque é onde moram
  `gen_random_uuid` e `btree_gist` (o Supabase põe as suas em `extensions`; num Postgres
  comum esse schema não existe, e nome inexistente em `search_path` é ignorado sem erro).
  Vale igual no `db:migrate` e no `db:seed`.
- **`db:migrate --reset` não derruba mais o `public` alheio.** Ele fazia
  `DROP SCHEMA public CASCADE` fixo — num projeto compartilhado, um comando de dev apagando
  dado de produção do vizinho, sem perguntar nada. Agora derruba o schema da instalação, e
  recusa rodar com `NODE_ENV=production`. Testado com um sistema vizinho no `public`: o
  reset recriou 27 tabelas do nosso schema e o vizinho ficou intacto.
- **Seed sem senha conhecida.** O padrão era `duda@dudamachado.com.br` / `dudamachado`,
  escrito no script **e no README**. É o mesmo defeito que já custou o painel de outro
  sistema da casa: senha versionada, e quem abriu o repositório entrou. Agora a senha é
  sorteada por execução e mostrada uma vez (só o hash vai ao banco), o seed recusa
  `NODE_ENV=production` sem `SEED_FORCE`, e os dados de demonstração deixaram de usar nome
  de pessoa real.
- **Estorno de pagamento** (migration `004_refunds.sql`). Ficha do atendimento → *Registrar
  devolução*, no todo ou em parte. É **registro, não transferência**: quem devolve o
  dinheiro é o dono, pelo Pix ou pela maquininha — não há gateway ligado, e mesmo quando
  houver, estorno de cartão passa pelo adquirente e demora dias. O texto da tela fala em
  "registrar" por isso.
  O valor virou coluna (`refunded_amount`) em vez de só um status, porque na prática o
  estorno costuma ser parcial; devolver metade mantém o pagamento `paid`, já que a outra
  metade continua sendo dinheiro que entrou. Descontar por linha negativa em `payments`
  não serve: o `CHECK (amount >= 0)` existe justamente para que nenhuma soma de
  faturamento precise lembrar de excluir linha negativa — a que esquecesse daria número
  errado sem erro nenhum.
  O estorno desfaz o efeito nos dois lugares: `payments.refunded_amount` sobe e
  `appointments.paid_amount` desce na mesma proporção com que subiu (mesmo rateio do
  `applyToGroup`, inclusive o ajuste do último, senão sobra centavo e vira cobrança
  fantasma de R$ 0,01 que ninguém quita), com o `payment_status` voltando para
  `partially_paid` ou `pending` — sem isso o horário seguiria marcado como pago e ninguém
  cobraria de novo.
  No Financeiro, *Entradas* continua sendo o bruto que entrou e o estorno tem linha
  própria, contada por `refunded_at`: descontar do mês do pagamento original mudaria um mês
  já fechado. ADMIN, e o `tenantId` vem da sessão — id de outra empresa dá 404. 5 testes
  e2e.
- **Comissão de profissionais.** Financeiro → *Comissões*: quanto cada um gerou no período
  e quanto tem a receber, com o total. Três decisões que mudam o número, e por isso estão
  escritas na tela e no `getCommissionReport`: conta só atendimento **concluído** (comissão
  se paga por serviço prestado, não por horário marcado); a base é o **serviço**, não o
  produto (o percentual é um campo só, e aplicar o mesmo número ao xampu seria chute —
  produto aparece como informação, fora da base); e conta pela **data do atendimento**,
  igual a "serviços realizados". A coluna *não recebido* separa a fatia cuja consulta ainda
  não foi paga — sem ela o dono acerta a comissão de dinheiro que não entrou. Só ADMIN,
  como o resto do Financeiro. Quem trabalhou com 0% configurado aparece destacado. 4 testes
  e2e mais o de papel.
- **Worker com escopo de tenant.** `/api/v1/jobs/run?tenant=<uuid>` limita a rodada a uma
  empresa; sem o parâmetro segue global, que é como o cron chama. Não é brecha: quem chega
  lá já provou saber o `CRON_SECRET`, então já podia rodar no sistema inteiro — restringir
  o alcance não concede nada. Era o que deixava `test:e2e` instável: os arquivos rodam em
  paralelo e duas suítes chamando o worker roubavam trabalho uma da outra, então a segunda
  recebia `reservasExpiradas: 0` e falhava sem nada estar quebrado (passava sempre rodando
  sozinha, a assinatura clássica de corrida entre suítes). Os testes usam `rodarWorker()`
  do helper. Tem regressão dos dois lados: com escopo a outra empresa não é tocada, sem
  escopo ela cai.

- **Rate limit agora é compartilhado.** `rateLimit` virou assíncrono e conta no Redis
  quando `UPSTASH_REDIS_REST_URL`/`_TOKEN` existem (aceita também os nomes
  `KV_REST_API_*`, que a integração da Vercel usa em projetos antigos). Sem Redis, cai
  para o `Map` do processo — o comportamento antigo — e o `check:env` avisa. INCR e
  PEXPIRE num script Lua, num passo só. Redis fora do ar não derruba o agendamento.
  Testado contra Redis de verdade em `tests/redis-compartilhado.test.ts`, que pula sozinho
  quando não há container (instruções no cabeçalho do arquivo).
- **Sessão do WhatsApp presa a um namespace (2026-08-31).** O bot Baileys é uma instância
  só atendendo todos os negócios da casa, e o id da sessão é a única coisa que separa um
  número do outro lá dentro. O `whatsapp_session_id`, editável por qualquer ADMIN nas
  Configurações e validado só como texto de até 60 caracteres, ia **cru** para o
  `POST /send`. Um ADMIN que escrevesse `espeto-na-brasa` passaria a mandar mensagem para
  qualquer número **saindo do WhatsApp da Espetaria**, a ler se aquela sessão estava
  conectada e — se estivesse fora do ar — a pedir o QR e parear o próprio celular no lugar
  dela. Agora todo id nasce com o prefixo `barb-` e passa por sanitização
  (`safeSessionId`), então nenhum valor digitado alcança sessão de fora deste sistema; como
  o slug do tenant é UNIQUE, duas empresas daqui também não colidem. 6 testes de regressão.
  O QR devolvido pelo gateway só é aceito como `data:image/`, senão o painel do dono
  buscaria um endereço externo sem ninguém pedir.

- **Passada de segurança antes do deploy (2026-08-28).** O que estava aberto e foi
  fechado: `/api/v1/payments/{id}` era público e entregava o `manage_token` do
  agendamento **antes do pagamento** — quem visse o id na URL controlava a reserva alheia
  sem pagar nada (agora só sai depois de confirmado, com id validado e limite por IP); o
  dashboard entregava faturamento, despesas e resultado a **STAFF**, contradizendo o
  Financeiro que exigia ADMIN; URL de imagem aceitava qualquer endereço e o otimizador do
  `next/image` a buscava do servidor, o que dava um SSRF para a rede interna e para o
  endpoint de metadados da nuvem; o worker aceitava o `CRON_SECRET` em `?secret=`, que
  vaza em log e em Referer; `/auth/refresh` não tinha limite; login entregava por tempo de
  resposta se o e-mail existia; e a aplicação não tinha nenhum cabeçalho de segurança.
  Detalhe completo no README, seção 12. `npm run check:env` derruba o deploy se algum
  segredo ainda for o de exemplo.

- **Venda avulsa de produto.** O cliente que entra só para comprar um xampu agora tem por
  onde passar: painel → Produtos → *Venda avulsa*. Tabelas `product_sales` /
  `product_sale_items`, cliente opcional, baixa de estoque com movimento e uma linha paga
  em `payments` — por isso já entra em *Entradas*, na quebra por método e em *produtos
  vendidos* sem query nova. Não cria agendamento de propósito. Cancelar devolve o estoque
  e tira do caixa, mantendo a linha marcada. 15 testes e2e.
  Fora de escopo por ora (foi combinado que a venda avulsa é rara): desconto por item,
  pagamento dividido em duas formas e comanda aberta em várias etapas.
- **Listas cortavam em silêncio.** Agendamentos e Clientes vinham com `limit` fixo e a tela
  não navegava — passou de 100 e o resto sumia sem aviso. Agora paginam de 50 em 50 com o
  total sempre à vista (`components/admin/Pagination.tsx`); mudar filtro volta para a
  primeira página.
- **Dois testes "com dia exclusivo" caíam no mesmo dia.** `diaUtil` empurra fim de semana
  para a segunda, então offsets separados por 2 dias colidiam sempre que o primeiro caía
  no sábado — e o bloqueio de um teste apagava o horário do outro, dependendo da data em
  que a suíte rodava. O passo virou 4.
- **Pausa pessoal apagava o almoço da empresa.** A regra "horário próprio substitui o da
  empresa" valia também para pausas, então uma folga individual reabria um horário com o
  estúdio fechado. Expediente substitui, pausa soma. Tem teste de regressão.
- **Configurações apagava as pausas por profissional.** Salvar a tela fazia `DELETE` em
  todas as pausas; agora o replace é escopado ao que veio no payload.
- **Resumo financeiro estourava 500.** Uma query recebia parâmetros que não usava e o
  Postgres não conseguia inferir o tipo.
- **Rate limit travava a suíte de testes.** Virou configurável por ambiente, com trava que
  o mantém sempre ligado quando `NODE_ENV=production` (com teste garantindo isso).
