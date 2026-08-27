# Pendências

O que ficou em aberto, com o porquê. Ordenado por prioridade — o topo é o que mais
atrapalha o dia a dia ou mais assusta em produção.

Legenda: **falta** = funcionalidade que não existe · **decisão** = está funcionando, mas
o comportamento precisa de confirmação · **risco** = funciona hoje e quebra ao crescer ·
**não verificado** = escrito, nunca exercitado de verdade.

---

## Alta

### 1. Venda avulsa de produto — *falta*
Hoje o produto só é vendido dentro de um atendimento. O cliente que entra só para comprar
um xampu não tem por onde passar.

Exige um caminho de receita fora do agendamento: uma "comanda" simples (cliente opcional,
itens, pagamento) alimentando o mesmo financeiro. Não dá para resolver criando agendamento
falso — sujaria a agenda e os relatórios de atendimento.

**Antes de implementar:** confirmar se isso acontece no salão e com que frequência.

### 2. Gateway de pagamento real nunca rodou — *não verificado*
Todo o fluxo de dinheiro foi testado com o provider `manual` (checkout simulado). O
`MercadoPagoProvider` está escrito — Pix com QR, cartão via Checkout Pro, validação de
assinatura `x-signature`, consulta na API antes de acreditar no status — mas **nenhuma
transação real passou por ele**.

Precisa de: credenciais de sandbox, um Pix de ponta a ponta, um cartão, e um teste de
webhook chegando de fora (a URL precisa ser pública — ngrok ou o deploy).

### 3. WhatsApp e IA nunca enviaram nada — *não verificado*
A fila de notificações funciona e está testada (as mensagens entram, saem da fila quando
o agendamento é cancelado, são reprogramadas ao remarcar). Mas com o gateway desligado
elas terminam como `skipped` — **nenhuma mensagem real foi enviada**.

Falta: parear uma sessão no bot Baileys, enviar uma confirmação de verdade, e ligar a
rota `/api/v1/ai/chat` no bot para o atendimento automático (o trecho está no README).

### 4. Migrations nunca rodaram em Postgres gerenciado — *não verificado*
Só foram exercitadas em Postgres 16 num container local. Em Supabase/Neon há dois pontos
de atenção:

- `CREATE EXTENSION btree_gist` — usado pela trava `excl_appt_overlap` contra double
  booking. A migration já degrada com aviso se não puder criar, **mas aí some a última
  camada de proteção**. Conferir se subiu.
- `pg_advisory_xact_lock` sob PgBouncer em modo *transaction* — funciona, mas o pool
  precisa estar em modo transação, não statement.

---

## Média

### 5. Rate limit é em memória — *risco*
`src/lib/http.ts` guarda os contadores num `Map` do processo. Com mais de uma instância
(ou serverless), cada uma tem o próprio contador e o limite vira ficção.

Trocar por Redis/Upstash mantendo a mesma assinatura de `rateLimit(key, limit, windowMs)`
— o resto do código não muda.

### 6. Listas sem paginação — *risco*
Agendamentos, clientes e produtos vêm com `limit` fixo (100–500) e a tela não navega. Com
um ano de histórico a lista corta em silêncio, que é o pior jeito de errar.

O backend já aceita `limit`/`offset`; falta a paginação na tela.

### 7. Data de "produtos vendidos" — *decisão*
Hoje segue a **data do atendimento** (igual a "serviços realizados"), enquanto *Entradas*
segue a **data do pagamento**. Um produto vendido hoje, num horário da semana que vem,
aparece no caixa hoje e na quebra de produtos lá.

É coerente e está explicado na tela, mas se o esperado for "produto conta no dia em que
saiu da prateleira", é trocar `a.starts_at` por `ap.created_at` em
`dashboard.service.ts` (duas queries).

### 8. Estorno e reembolso — *falta*
`payment_status` já prevê `refunded`, e a política de perda do sinal em caso de falta está
nas configurações (`forfeit_deposit_on_no_show`), mas **não há fluxo**: não dá para
estornar um pagamento nem registrar a devolução do sinal.

### 9. Comissão de profissionais — *falta*
`professionals.commission_percent` existe e é editável, mas nada calcula nem mostra. Falta
o relatório de quanto cada profissional gerou e quanto tem a receber.

---

## Baixa

### 10. Feriados nacionais — *falta*
Fechar em feriado é manual. Pré-carregar os nacionais seria conveniente, mas varia por
cidade/estado e viraria regra fixa no código — precisaria vir de configuração ou de uma
tabela por tenant.

### 11. Importar os dados reais do Duda Machado — *falta*
O sistema atual do Duda (`Duda-machado-main`, Supabase) tem profissionais, categorias,
serviços e clientes reais. O plano combinado: manter o schema multi-tenant novo e escrever
um importador **somente leitura** sobre o banco dele.

⚠️ **O sistema do Duda está no ar.** Qualquer script só lê; nada de escrever ou alterar
schema lá.

### 12. Domínio próprio — *falta*
`tenants.custom_domain` existe e é único, mas a resolução por host não foi implementada —
hoje o tenant sai sempre do slug na URL.

### 13. Upload de imagem — *falta*
Logo, foto de profissional e imagem de serviço/produto só aceitam URL. Falta upload
(Vercel Blob ou storage do Supabase).

### 14. Recuperação de senha — *falta*
Não há "esqueci minha senha". Hoje só resolve mexendo no banco.

---

## Já resolvido (para não reabrir)

- **Pausa pessoal apagava o almoço da empresa.** A regra "horário próprio substitui o da
  empresa" valia também para pausas, então uma folga individual reabria um horário com o
  estúdio fechado. Expediente substitui, pausa soma. Tem teste de regressão.
- **Configurações apagava as pausas por profissional.** Salvar a tela fazia `DELETE` em
  todas as pausas; agora o replace é escopado ao que veio no payload.
- **Resumo financeiro estourava 500.** Uma query recebia parâmetros que não usava e o
  Postgres não conseguia inferir o tipo.
- **Rate limit travava a suíte de testes.** Virou configurável por ambiente, com trava que
  o mantém sempre ligado quando `NODE_ENV=production` (com teste garantindo isso).
