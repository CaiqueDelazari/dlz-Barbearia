-- ============================================================================
-- 005_owner_notifications.sql  |  A barbearia tambem recebe aviso
-- ============================================================================
--
-- Ate aqui todo aviso falava com o cliente: os seis templates e todos os
-- enfileiramentos usavam `client_phone`, sem excecao. A loja nao ficava sabendo
-- de nada -- quem marcava pelo site aparecia sem avisar ninguem, e cancelamento
-- so era descoberto abrindo a agenda.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS owner_notify_phone   text,
  ADD COLUMN IF NOT EXISTS owner_notify_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN business_settings.owner_notify_phone IS
  'Numero da loja que recebe os avisos de agenda. Vazio = nao envia, mesmo com owner_notify_enabled.';

-- Sem numero cadastrado nao ha para onde mandar, entao a loja herda o telefone
-- que ja esta no cadastro da empresa. Quem quiser outro numero (o celular do
-- dono, um grupo) troca nas Configuracoes.
UPDATE business_settings bs
   SET owner_notify_phone = COALESCE(t.whatsapp, t.phone)
  FROM tenants t
 WHERE t.id = bs.tenant_id
   AND bs.owner_notify_phone IS NULL;

-- ---------------------------------------------------------------- limpeza
-- O atendimento por IA saiu do produto: o cliente quer o bot avisando, nao
-- respondendo. Estas duas tabelas guardavam a conversa da IA e nao sobrou
-- nada no codigo que as leia ou escreva.
DROP TABLE IF EXISTS whatsapp_messages;
DROP TABLE IF EXISTS whatsapp_conversations;
