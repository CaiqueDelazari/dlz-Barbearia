# Pendências

O que ficou em aberto, com o porquê. Ordenado por prioridade — o topo é o que mais
atrapalha o dia a dia ou mais assusta em produção.

Legenda: **falta** = funcionalidade que não existe · **decisão** = está funcionando, mas
o comportamento precisa de confirmação · **risco** = funciona hoje e quebra ao crescer ·
**não verificado** = escrito, nunca exercitado de verdade.

---

## Alta

### 1. Gateway de pagamento online nunca rodou — *não verificado*
Todo o fluxo de dinheiro foi testado com o provider `manual` (checkout simulado). O
`MercadoPagoProvider` está escrito — Pix com QR, cartão via Checkout Pro, validação de
assinatura `x-signature`, consulta na API antes de acreditar no status — mas **nenhuma
transação real passou por ele**.

⚠️ **Combinado em 2026-08-28: o Duda recebe pela Stone.** A Stone é onde o dinheiro cai,
não uma integração — pagamento na maquininha do balcão é registrado como `card` e já
funciona hoje (inclusive na venda avulsa). O gateway online só entra em cena se um dia se
quiser cobrar o **sinal pela internet, antes do cliente vir**; aí o caminho da Stone é a
Pagar.me, e o `MercadoPagoProvider` não serve — seria trocar o provider.

Enquanto isso não for decidido, `PAYMENT_PROVIDER=manual` é a configuração correta.

### 2. WhatsApp e IA nunca enviaram nada — *não verificado*
A fila de notificações funciona e está testada (as mensagens entram, saem da fila quando
o agendamento é cancelado, são reprogramadas ao remarcar). Mas com o gateway desligado
elas terminam como `skipped` — **nenhuma mensagem real foi enviada**.

Falta: parear uma sessão no bot Baileys, enviar uma confirmação de verdade, e ligar a
rota `/api/v1/ai/chat` no bot para o atendimento automático (o trecho está no README).

### 3. Migrations nunca rodaram em Postgres gerenciado — *não verificado*
As três migrations (`001_init`, `002_products`, `003_sales`) só foram exercitadas em
Postgres 16 num container local. Em Supabase/Neon há dois pontos de atenção:

- `CREATE EXTENSION btree_gist` — usado pela trava `excl_appt_overlap` contra double
  booking. A migration já degrada com aviso se não puder criar, **mas aí some a última
  camada de proteção**. Conferir se subiu.
- `pg_advisory_xact_lock` sob PgBouncer em modo *transaction* — funciona, mas o pool
  precisa estar em modo transação, não statement.

---

## Média

### 4. Next.js 14 tem avisos de segurança sem correção no 14.x — *risco*
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

### 6. Estorno e reembolso de pagamento — *falta*
`payment_status` já prevê `refunded`, e a política de perda do sinal em caso de falta está
nas configurações (`forfeit_deposit_on_no_show`), mas **não há fluxo**: não dá para
estornar um pagamento de agendamento nem registrar a devolução do sinal.

A venda avulsa já tem o caminho de desfazer (cancelar devolve o estoque e tira do caixa) —
serve de modelo, mas o pagamento de agendamento é mais complicado porque pode ser parcial.

### 7. Comissão de profissionais — *falta*
`professionals.commission_percent` existe e é editável, mas nada calcula nem mostra. Falta
o relatório de quanto cada profissional gerou e quanto tem a receber.

### 8. Testes e2e se atrapalham quando rodam juntos — *risco*
`npm run test:e2e` roda os arquivos em paralelo e o worker de `/api/v1/jobs/run` é global:
ele varre os holds vencidos de **todos** os tenants. Duas suítes chamando o worker ao
mesmo tempo roubam trabalho uma da outra, e o teste "o worker devolve o horário não pago"
falha de vez em quando. Rodando o arquivo sozinho passa sempre.

Conserto: dar escopo de tenant ao worker quando chamado pela API (o cron continua global).

---

## Baixa

### 9. Feriados nacionais — *falta*
Fechar em feriado é manual. Pré-carregar os nacionais seria conveniente, mas varia por
cidade/estado e viraria regra fixa no código — precisaria vir de configuração ou de uma
tabela por tenant.

### 10. Importar os dados reais do Duda Machado — *falta*
O sistema atual do Duda (`Duda-machado-main`, Supabase) tem profissionais, categorias,
serviços e clientes reais. O plano combinado: manter o schema multi-tenant novo e escrever
um importador **somente leitura** sobre o banco dele.

⚠️ **O sistema do Duda está no ar.** Qualquer script só lê; nada de escrever ou alterar
schema lá.

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

- **Rate limit agora é compartilhado.** `rateLimit` virou assíncrono e conta no Redis
  quando `UPSTASH_REDIS_REST_URL`/`_TOKEN` existem (aceita também os nomes
  `KV_REST_API_*`, que a integração da Vercel usa em projetos antigos). Sem Redis, cai
  para o `Map` do processo — o comportamento antigo — e o `check:env` avisa. INCR e
  PEXPIRE num script Lua, num passo só. Redis fora do ar não derruba o agendamento.
  Testado contra Redis de verdade em `tests/redis-compartilhado.test.ts`, que pula sozinho
  quando não há container (instruções no cabeçalho do arquivo).
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
