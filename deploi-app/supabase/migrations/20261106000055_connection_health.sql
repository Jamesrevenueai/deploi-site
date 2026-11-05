-- =============================================================================
-- Connection health for the integration hub (lib/integrations):
--   connection_health        one row per probe of one connection (history). previous_status -> status is
--                            the transition operations alerting reads; a row whose two differ is a change.
--   connection_health_state  the current health of each connection: consecutive failures and when the
--                            next scheduled probe is due (exponential backoff after failures).
-- connection_id names a store connection, an office connection or an email account (three tables), so it
-- carries no foreign key; rows go with their organization.
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every write
-- goes through server code (service role).
-- Rollback: supabase/rollback/20261106000055_connection_health.down.sql
-- =============================================================================

create table if not exists connection_health (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  integration text not null check (integration in ('shopify', 'woocommerce', 'hubspot', 'google_calendar', 'quickbooks', 'agent_mailbox', 'gmail', 'microsoft', 'stripe')),
  connection_id uuid not null,
  -- schedule: the hourly connection.health job; manual: the Test button; reconnect: a completed reconnection
  trigger text not null default 'schedule' check (trigger in ('schedule', 'manual', 'reconnect')),
  ok boolean not null,
  previous_status text check (previous_status in ('connected', 'needs_reauth', 'error', 'not_connected', 'not_configured')),
  status text not null check (status in ('connected', 'needs_reauth', 'error', 'not_connected', 'not_configured')),
  -- short machine code of a failure (auth, forbidden, timeout, network, server, rate_limited, ...)
  code text check (code is null or code ~ '^[a-z][a-z0-9_]{0,40}$'),
  -- human-readable result; never a token, a body or a personal record
  message text not null check (length(message) <= 500),
  latency_ms int check (latency_ms >= 0),
  -- what the provider exposes about headroom and expiry (rate-limit remaining, token expiry), never secrets
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists connection_health_org_idx on connection_health (org_id, integration, checked_at desc);
create index if not exists connection_health_conn_idx on connection_health (connection_id, checked_at desc);
create index if not exists connection_health_transitions on connection_health (checked_at) where previous_status is distinct from status;

create table if not exists connection_health_state (
  org_id uuid not null references agencies(id) on delete cascade,
  integration text not null check (integration in ('shopify', 'woocommerce', 'hubspot', 'google_calendar', 'quickbooks', 'agent_mailbox', 'gmail', 'microsoft', 'stripe')),
  connection_id uuid not null,
  status text not null check (status in ('connected', 'needs_reauth', 'error', 'not_connected', 'not_configured')),
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  next_probe_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,40}$'),
  last_error text check (length(last_error) <= 500),
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (integration, connection_id)
);
create index if not exists connection_health_state_due on connection_health_state (next_probe_at);
create index if not exists connection_health_state_org on connection_health_state (org_id);

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['connection_health', 'connection_health_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
