-- ============================================================================
-- 001_init.sql  |  Base multi-tenant do SaaS de agendamento
-- Regra geral: TODA tabela de negocio carrega tenant_id e e filtrada por ele.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'STAFF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM
    ('pending', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM
    ('pending', 'processing', 'paid', 'partially_paid', 'failed', 'refunded', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('pix', 'card', 'cash', 'transfer', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_kind AS ENUM ('deposit', 'full', 'remaining', 'onsite');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_source AS ENUM ('online', 'manual', 'whatsapp', 'ai');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- tenants
CREATE TABLE IF NOT EXISTS tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  document        text,
  phone           text,
  whatsapp        text,
  instagram       text,
  address         text,
  logo_url        text,
  cover_url       text,
  custom_domain   text UNIQUE,
  timezone        text NOT NULL DEFAULT 'America/Sao_Paulo',
  currency        text NOT NULL DEFAULT 'BRL',
  plan            text NOT NULL DEFAULT 'trial',
  trial_ends_at   timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants (active) WHERE active;
DROP TRIGGER IF EXISTS trg_tenants_updated ON tenants;
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- business_settings
-- Nada de regra fixa no codigo: tudo que muda por empresa mora aqui.
CREATE TABLE IF NOT EXISTS business_settings (
  tenant_id                          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  slot_interval_minutes              integer NOT NULL DEFAULT 30 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  min_advance_minutes                integer NOT NULL DEFAULT 60,
  max_advance_days                   integer NOT NULL DEFAULT 60,
  minimum_reschedule_notice_minutes  integer NOT NULL DEFAULT 120,
  allow_client_cancel                boolean NOT NULL DEFAULT true,
  online_payment_required            boolean NOT NULL DEFAULT true,
  allow_deposit                      boolean NOT NULL DEFAULT true,
  allow_full_payment                 boolean NOT NULL DEFAULT true,
  deposit_percent                    numeric(5,2) NOT NULL DEFAULT 50 CHECK (deposit_percent > 0 AND deposit_percent <= 100),
  forfeit_deposit_on_no_show         boolean NOT NULL DEFAULT true,
  hold_expiration_minutes            integer NOT NULL DEFAULT 15,
  allow_split_appointments           boolean NOT NULL DEFAULT true,
  allow_professional_choice          boolean NOT NULL DEFAULT true,
  reminder_24h_enabled               boolean NOT NULL DEFAULT true,
  reminder_1h_enabled                boolean NOT NULL DEFAULT true,
  return_reminder_enabled            boolean NOT NULL DEFAULT true,
  return_reminder_days               integer NOT NULL DEFAULT 15,
  manage_link_ttl_hours              integer NOT NULL DEFAULT 720,
  payment_methods                    text[] NOT NULL DEFAULT ARRAY['pix','card']::text[],
  whatsapp_session_id                text,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_settings_updated ON business_settings;
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON business_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  email          text NOT NULL,
  phone          text,
  password_hash  text NOT NULL,
  role           user_role NOT NULL DEFAULT 'STAFF',
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_email ON users (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);

-- ---------------------------------------------------------- professionals
CREATE TABLE IF NOT EXISTS professionals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  bio           text,
  photo_url     text,
  phone         text,
  commission_percent numeric(5,2) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_professionals_tenant ON professionals (tenant_id, active);
DROP TRIGGER IF EXISTS trg_professionals_updated ON professionals;
CREATE TRIGGER trg_professionals_updated BEFORE UPDATE ON professionals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------- services
CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  price            numeric(10,2) NOT NULL CHECK (price >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  image_url        text,
  category         text,
  display_order    integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_tenant ON services (tenant_id, active, display_order);
DROP TRIGGER IF EXISTS trg_services_updated ON services;
CREATE TRIGGER trg_services_updated BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vinculo servico <-> profissional. Sem linhas = todos atendem o servico.
CREATE TABLE IF NOT EXISTS professional_services (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id      uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_prof_services_service ON professional_services (service_id);

-- ---------------------------------------------------------------- clients
CREATE TABLE IF NOT EXISTS clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  phone          text NOT NULL,
  email          text,
  birth_date     date,
  notes          text,
  blocked        boolean NOT NULL DEFAULT false,
  no_show_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_tenant_phone ON clients (tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_tenant_name ON clients (tenant_id, lower(name));
DROP TRIGGER IF EXISTS trg_clients_updated ON clients;
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------- horarios/bloqueios
CREATE TABLE IF NOT EXISTS business_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
  opens_at        time NOT NULL,
  closes_at       time NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS idx_hours_lookup ON business_hours (tenant_id, professional_id, weekday);

CREATE TABLE IF NOT EXISTS business_breaks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at       time NOT NULL,
  ends_at         time NOT NULL,
  label           text,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_breaks_lookup ON business_breaks (tenant_id, professional_id, weekday);

-- Feriado, folga, ferias e bloqueio pontual: tudo aqui.
CREATE TABLE IF NOT EXISTS blocked_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  kind            text NOT NULL DEFAULT 'block', -- block | holiday | vacation | dayoff
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_blocks_range ON blocked_periods (tenant_id, starts_at, ends_at);

-- ----------------------------------------------------------- appointments
CREATE TABLE IF NOT EXISTS appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_group_id  uuid NOT NULL,                       -- amarra horarios separados da mesma reserva
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  professional_id   uuid REFERENCES professionals(id) ON DELETE SET NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  duration_minutes  integer NOT NULL CHECK (duration_minutes > 0),
  status            appointment_status NOT NULL DEFAULT 'pending',
  source            appointment_source NOT NULL DEFAULT 'online',
  total_amount      numeric(10,2) NOT NULL DEFAULT 0,
  paid_amount       numeric(10,2) NOT NULL DEFAULT 0,
  payment_status    payment_status NOT NULL DEFAULT 'pending',
  hold_expires_at   timestamptz,                          -- reserva temporaria (pagamento online)
  manage_token      text UNIQUE,
  manage_token_expires_at timestamptz,
  notes             text,
  cancelled_at      timestamptz,
  cancelled_reason  text,
  rescheduled_from  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_appt_tenant_start ON appointments (tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_prof_start ON appointments (professional_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments (client_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_appt_group ON appointments (booking_group_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments (tenant_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_hold ON appointments (hold_expires_at) WHERE status = 'pending';
DROP TRIGGER IF EXISTS trg_appt_updated ON appointments;
CREATE TRIGGER trg_appt_updated BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Blindagem contra double booking direto no banco (alem do lock na transacao).
DO $blk$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  BEGIN
    ALTER TABLE appointments ADD CONSTRAINT excl_appt_overlap
      EXCLUDE USING gist (
        professional_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status IN ('pending','confirmed','completed') AND professional_id IS NOT NULL);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'btree_gist indisponivel: double booking segue protegido pelo lock da aplicacao';
END $blk$;

CREATE TABLE IF NOT EXISTS appointment_services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id       uuid REFERENCES services(id) ON DELETE SET NULL,
  service_name     text NOT NULL,       -- snapshot: preco/nome mudam, historico nao
  price            numeric(10,2) NOT NULL,
  duration_minutes integer NOT NULL,
  position         integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_appt_services_appt ON appointment_services (appointment_id);
CREATE INDEX IF NOT EXISTS idx_appt_services_service ON appointment_services (tenant_id, service_id);

-- --------------------------------------------------------------- payments
CREATE TABLE IF NOT EXISTS payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_group_id   uuid,
  appointment_id     uuid REFERENCES appointments(id) ON DELETE SET NULL,
  client_id          uuid REFERENCES clients(id) ON DELETE SET NULL,
  amount             numeric(10,2) NOT NULL CHECK (amount >= 0),
  kind               payment_kind NOT NULL DEFAULT 'full',
  method             payment_method,
  status             payment_status NOT NULL DEFAULT 'pending',
  provider           text NOT NULL DEFAULT 'manual',
  provider_payment_id text,
  idempotency_key    text NOT NULL,
  checkout_url       text,
  qr_code            text,
  qr_code_base64     text,
  expires_at         timestamptz,
  paid_at            timestamptz,
  refunded_at        timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idem ON payments (tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_id ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_group ON payments (booking_group_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_status ON payments (tenant_id, status, created_at DESC);
DROP TRIGGER IF EXISTS trg_payments_updated ON payments;
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cada webhook entra aqui uma unica vez: e o que garante idempotencia.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  external_id   text NOT NULL,
  event_type    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- --------------------------------------------------------------- expenses
CREATE TABLE IF NOT EXISTS expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  description    text NOT NULL,
  category       text,
  amount         numeric(10,2) NOT NULL CHECK (amount >= 0),
  date           date NOT NULL,
  payment_method payment_method,
  notes          text,
  recurring      boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date ON expenses (tenant_id, date DESC);
DROP TRIGGER IF EXISTS trg_expenses_updated ON expenses;
CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------- notificacoes
CREATE TABLE IF NOT EXISTS notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,   -- confirmation | reminder_24h | reminder_1h | return | cancelled | payment_link
  channel     text NOT NULL DEFAULT 'whatsapp',
  body        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, channel)
);
DROP TRIGGER IF EXISTS trg_templates_updated ON notification_templates;
CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE CASCADE,
  type           text NOT NULL,
  channel        text NOT NULL DEFAULT 'whatsapp',
  to_phone       text,
  body           text NOT NULL,
  status         notification_status NOT NULL DEFAULT 'scheduled',
  scheduled_for  timestamptz NOT NULL,
  sent_at        timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  error          text,
  dedupe_key     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications (status, scheduled_for);
DROP TRIGGER IF EXISTS trg_notifications_updated ON notifications;
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------- whatsapp/ia
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE SET NULL,
  phone          text NOT NULL,
  ai_enabled     boolean NOT NULL DEFAULT true,
  last_message_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  body            text NOT NULL,
  external_id     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_conv ON whatsapp_messages (conversation_id, created_at);

-- ------------------------------------------------------------- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor       text NOT NULL DEFAULT 'system',  -- user:<id> | client | system | ai
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity, entity_id);
