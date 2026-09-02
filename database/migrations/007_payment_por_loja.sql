-- ============================================================================
-- 007_payment_por_loja.sql  |  Cobranca online e' de quem contratou, nao de todos
-- ============================================================================
--
-- O gateway era escolhido por `PAYMENT_PROVIDER`, uma variavel de ambiente --
-- ou seja, uma decisao por DEPLOY, num sistema onde um deploy atende varias
-- barbearias. Como as credenciais tambem vem do ambiente, a conta do gateway e'
-- uma so: a de quem contratou a cobranca online.
--
-- O buraco: `online_payment_required` ja e' por loja e vem ligado por padrao.
-- Qualquer loja nova, ao ser criada, ficava pedindo pagamento online -- e o
-- dinheiro do cliente dela cairia na conta de OUTRA barbearia, a dona das
-- credenciais. Nao ha erro, nao ha aviso: o Pix simplesmente sai certo para o
-- destino errado.
--
-- Duas mudancas fecham isso:
--
--   1. `payment_provider` por loja, 'manual' por padrao. Gateway de verdade so
--      para quem tem a coluna preenchida. As demais registram pagamento no
--      balcao, que e' o que uma barbearia sem contrato de cobranca online faz.
--
--   2. `online_payment_required` passa a nascer DESLIGADO. Exigir pagamento
--      online por padrao so faz sentido num sistema de loja unica; aqui e' o
--      contrario do esperado.
--
-- `payment_provider` e' de proposito uma coluna que o painel NAO edita: quem a
-- muda e' o dono da plataforma, direto no banco. Se um ADMIN pudesse escrever
-- 'pagarme' ali pela tela de Configuracoes, estaria de volta o mesmo buraco --
-- so que com um clique em vez de um deploy.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN business_settings.payment_provider IS
  'Gateway desta loja. manual = registra no balcao. Nao editavel pelo painel: e configuracao de plataforma, nao de loja.';

ALTER TABLE business_settings
  ALTER COLUMN online_payment_required SET DEFAULT false;

-- Quem ja existe e nao tem gateway configurado para de pedir pagamento online.
-- Sem isso, uma loja cadastrada antes desta migration continuaria cobrando para
-- a conta alheia.
UPDATE business_settings
   SET online_payment_required = false
 WHERE payment_provider = 'manual';
