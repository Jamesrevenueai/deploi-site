-- =============================================================================
-- Deploi Commerce for WooCommerce. Two service-only tables; store_connections and store_credentials
-- already allow platform 'woocommerce' and token_kind 'api_key_pair' (the consumer key pair, encrypted
-- by the application with AES-256-GCM, connection id as AAD).
--   woo_auth_states   one-time, expiring, organization-bound states for WooCommerce's key-approval flow
--                     (/wc-auth/v1/authorize). The key pair WooCommerce posts back is held here, encrypted,
--                     only until the connection is finalized, then erased.
--   woo_connections   per-connection WooCommerce facts: the site URL, how credentials are sent, versions,
--                     and the webhook ids and encrypted webhook signing secret.
-- Neither table has a policy for user sessions: they are unreadable from the browser.
-- Rollback: supabase/rollback/20261104000038_woocommerce.down.sql
-- =============================================================================
create table if not exists woo_auth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  created_by text not null,
  profile_id uuid,
  site_url text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'received', 'connecting', 'connected', 'failed')),
  status_reason text,
  key_id text,
  keys_ciphertext text,
  key_permissions text,
  connection_id uuid references store_connections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists woo_auth_states_org_idx on woo_auth_states (org_id, created_at desc);

create table if not exists woo_connections (
  connection_id uuid primary key references store_connections(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  site_url text not null,
  auth_mode text not null default 'basic' check (auth_mode in ('basic', 'query')),
  connected_via text not null check (connected_via in ('authorize', 'manual', 'synthetic')),
  wc_version text,
  wp_version text,
  remote_key_id bigint,
  webhook_ids bigint[] not null default '{}',
  webhook_key_id text,
  webhook_secret_ciphertext text,
  webhooks_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists woo_connections_org_idx on woo_connections (org_id);

alter table woo_auth_states enable row level security;
alter table woo_connections enable row level security;
revoke all on woo_auth_states from authenticated;
revoke all on woo_connections from authenticated;
grant all on woo_auth_states to service_role;
grant all on woo_connections to service_role;
drop trigger if exists touch_updated_woo_auth_states on woo_auth_states;
create trigger touch_updated_woo_auth_states before update on woo_auth_states for each row execute function set_updated_at();
drop trigger if exists touch_updated_woo_connections on woo_connections;
create trigger touch_updated_woo_connections before update on woo_connections for each row execute function set_updated_at();
