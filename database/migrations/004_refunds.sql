-- ============================================================================
-- 004_refunds.sql  |  Estorno de pagamento
--
-- `payments.status` ja previa 'refunded' e a coluna `refunded_at` ja existia,
-- mas as duas juntas so contam uma historia: devolveu tudo, ou nao devolveu.
-- Na pratica o estorno costuma ser parcial -- o cliente pagou o sinal de 50 e
-- desistiu de um dos dois horarios, ou o dono devolve metade por cortesia.
--
-- Por isso o valor vira coluna propria em vez de um status. `refunded_amount`
-- guarda quanto ja voltou, e o status passa a ser consequencia dele: enquanto
-- for menor que `amount`, o pagamento continua 'paid' com uma parte devolvida.
--
-- A alternativa seria uma linha nova em `payments` com valor negativo, mas o
-- CHECK (amount >= 0) existe justamente para impedir isso, e por bom motivo:
-- toda soma de faturamento do sistema teria que lembrar de excluir as linhas
-- negativas, e a que esquecesse daria um numero errado sem erro nenhum.
-- ============================================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_reason   text;

-- Nao se devolve mais do que se recebeu. Sem esta trava, um clique repetido no
-- botao de estornar zeraria o caixa aos poucos, e o rastro ficaria coerente.
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS chk_payments_refund_cabe;
ALTER TABLE payments
  ADD CONSTRAINT chk_payments_refund_cabe
  CHECK (refunded_amount >= 0 AND refunded_amount <= amount);

-- O financeiro pergunta "o que foi estornado neste periodo?", e a resposta sai
-- por refunded_at -- que e' uma data diferente da do pagamento original.
CREATE INDEX IF NOT EXISTS idx_payments_refunded
  ON payments (tenant_id, refunded_at)
  WHERE refunded_amount > 0;
