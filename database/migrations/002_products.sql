-- ============================================================================
-- 002_products.sql  |  Produtos, venda no atendimento e controle de estoque
-- ============================================================================

CREATE TABLE IF NOT EXISTS products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  brand            text,
  category         text,
  sku              text,
  price            numeric(10,2) NOT NULL CHECK (price >= 0),        -- venda
  cost_price       numeric(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0), -- custo
  -- Nem todo item é controlado: xampu de revenda sim, toalha não.
  track_stock      boolean NOT NULL DEFAULT true,
  stock_quantity   integer NOT NULL DEFAULT 0,
  min_stock        integer NOT NULL DEFAULT 0,
  image_url        text,
  display_order    integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products (tenant_id, active, display_order);
CREATE INDEX IF NOT EXISTS idx_products_low_stock ON products (tenant_id)
  WHERE track_stock AND active;
DROP TRIGGER IF EXISTS trg_products_updated ON products;
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Produto vendido dentro de um atendimento. Snapshot de nome e preço: o
-- histórico não pode mudar quando a tabela de preços mudar.
CREATE TABLE IF NOT EXISTS appointment_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  product_id     uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name   text NOT NULL,
  unit_price     numeric(10,2) NOT NULL,
  quantity       integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total          numeric(10,2) NOT NULL,
  sold_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appt_products_appt ON appointment_products (appointment_id);
CREATE INDEX IF NOT EXISTS idx_appt_products_tenant ON appointment_products (tenant_id, created_at DESC);

-- Toda mexida no estoque vira linha aqui: venda, entrada, ajuste e devolução.
-- Sem isso, "sumiu um xampu" não tem resposta.
CREATE TABLE IF NOT EXISTS product_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity       integer NOT NULL,        -- negativo = saída
  reason         text NOT NULL,           -- sale | restock | adjustment | return | loss
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  notes          text,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON product_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_tenant ON product_movements (tenant_id, created_at DESC);
