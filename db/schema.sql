-- Robocote 2.0 — base multi-tenant inicial
-- Execute em um Postgres novo antes de ligar DATABASE_URL no app.

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  document_type text CHECK (document_type IN ('cpf', 'cnpj')),
  document text,
  document_digits text UNIQUE,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS document_type text CHECK (document_type IN ('cpf', 'cnpj'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS document text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS document_digits text UNIQUE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone text;
-- Semi-white-label: cada corretora batiza o próprio agente (Helena, Carlos, etc).
-- Null = usar default do ambiente (ROBOCOTE_AGENT_NAME) ou 'Robocote'.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agent_name text;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;

CREATE TABLE IF NOT EXISTS tenant_memberships (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'operador')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS superadmin_users (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evolution_instance_name text NOT NULL UNIQUE,
  owner_phone text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'qrcode', 'connecting', 'connected', 'disconnected', 'logged_out', 'error')),
  last_connection_state text,
  last_qr_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_sessions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('webchat', 'whatsapp')),
  channel_user_id text NOT NULL,
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, channel_user_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_sessions_tenant_updated
  ON lead_sessions (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Versionamento do JSON canônico de configuração da corretora.
-- Insert-only: cada salvamento gera nova linha; tenants.current_config_id aponta pra última ativa.
-- source distingue origem do salvamento; change_note é nota livre do operador.
CREATE TABLE IF NOT EXISTS tenant_configs (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  config       jsonb NOT NULL,
  config_hash  text NOT NULL,
  source       text NOT NULL CHECK (source IN (
                 'onboarding_initial','panel_edit','admin_override',
                 'migration','rollback'
               )),
  changed_by   text REFERENCES users(id) ON DELETE SET NULL,
  change_note  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_configs_tenant_created
  ON tenant_configs (tenant_id, created_at DESC);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_config_id bigint
  REFERENCES tenant_configs(id) ON DELETE SET NULL;

-- Credenciais sensíveis (Segfy etc) criptografadas via AES-256-GCM.
-- Formato de cada campo: "iv_hex:authTag_hex:ciphertext_b64" (encode em src/tenant/credentials.ts).
-- Chave de criptografia vem da env CREDENTIAL_ENCRYPTION_KEY (32 bytes em hex).
CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id              text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  segfy_corretora_token  text,
  segfy_client_id        text,
  segfy_client_secret    text,
  encryption_version     smallint NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Seed mínimo para desenvolvimento local.
INSERT INTO tenants (id, slug, name)
VALUES ('rpi', 'rpi', 'Corretora Piloto RPI')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, name, email, status)
VALUES ('taskdun-superadmin', 'Taskdun Superadmin', 'admin@taskdun.com.br', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO superadmin_users (user_id)
VALUES ('taskdun-superadmin')
ON CONFLICT (user_id) DO NOTHING;
