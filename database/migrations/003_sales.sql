-- ============================================================================
-- 003_sales.sql  |  Venda avulsa de produto (sem agendamento)
--
-- O cliente que entra so para comprar um xampu nao tem agendamento. Criar um
-- agendamento falso para ele sujaria a agenda e todo relatorio de atendimento,
-- entao a venda de balcao mora em tabela propria e chega ao financeiro pelo
-- mesmo caminho de sempre: uma linha em `payments`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- opcional de proposito: quem passa so para comprar costuma nao se cadastrar
  client_id        uuid REFERENCES clients(id) ON DELETE SET NULL,
  total            numeric(10,2) NOT NULL CHECK (total >= 0),
  method           payment_method NOT NULL,
  notes            text,
  sold_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at     timestamptz,
  cancelled_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON product_sales (tenant_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_sales_updated ON product_sales;
CREATE TRIGGER trg_sales_updated BEFORE UPDATE ON product_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Mesmo snapshot de nome e preco de appointment_products: historico nao muda
-- quando a tabela de precos mudar.
CREATE TABLE IF NOT EXISTS product_sale_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id      uuid NOT NULL REFERENCES product_sales(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  unit_price   numeric(10,2) NOT NULL,
  quantity     integer NOT NULL CHECK (quantity > 0),
  total        numeric(10,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON product_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_tenant ON product_sale_items (tenant_id, created_at DESC);

-- O movimento de estoque precisa saber de qual venda veio, senao "sumiu um
-- xampu" volta a nao ter resposta.
ALTER TABLE product_movements
  ADD COLUMN IF NOT EXISTS sale_id uuid REFERENCES product_sales(id) ON DELETE SET NULL;

-- A venda de balcao entra no caixa pela mesma porta que todo o resto: uma
-- linha paga em `payments`. Assim Entradas e "por metodo" ja a enxergam sem
-- nenhuma query nova.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS sale_id uuid REFERENCES product_sales(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments (sale_id) WHERE sale_id IS NOT NULL;
