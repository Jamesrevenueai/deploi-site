-- =============================================================================
-- Autonomy on connect (lib/autonomy/on-connect.ts): the moment a system is connected, Deploi turns the business's
-- packs on, sets up the recommended Office team at the owner's autonomy settings, runs the first check at once and
-- tells the owner what it found. Customer-facing messages in the first 24 hours are paced.
--   pack_settings.source      'owner' (the owner chose the business type) or 'inferred' (set from what was
--                             connected, never over an owner's choice); inferred_from names the connection kind
--   autonomy_connects         one row per organization and connection: when it connected and what the first run did
--                             (the dedupe of the on-connect work: a second connect event for the same connection does
--                             nothing new)
--   autonomy_outbound         the first-run pacing ledger: one row per customer-facing message allowed out in the
--                             first 24 hours after a connect (at most the organization's hourly cap per rolling hour)
--   autonomy_backlog          customer-facing messages held by the pacing for a later hour, and when each is released
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes through
-- server code (service role). No customer names, emails or addresses are stored here (only problem keys).
-- Rollback: supabase/rollback/20261107000063_autonomy_on_connect.down.sql
-- =============================================================================

alter table pack_settings add column if not exists source text not null default 'owner';
alter table pack_settings drop constraint if exists pack_settings_source_check;
alter table pack_settings add constraint pack_settings_source_check check (source in ('owner', 'inferred'));
alter table pack_settings add column if not exists inferred_from text check (length(inferred_from) <= 80);

create table if not exists autonomy_connects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  kind text not null check (kind in ('shopify', 'woocommerce', 'office', 'email', 'buildium')),
  provider text check (length(provider) <= 40),
  connection_id uuid not null,
  connected_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- the first-check sweep routed for this connection (agent_events.id)
  event_id uuid,
  -- what the first run did: packs, discovery run, team, counts (no customer data)
  result jsonb not null default '{}'::jsonb,
  summary_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, connection_id)
);
create index if not exists autonomy_connects_org_recent on autonomy_connects (org_id, connected_at desc);

create table if not exists autonomy_outbound (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  ref text not null check (length(ref) between 1 and 320),
  agent_key text check (length(agent_key) <= 120),
  action_type text check (length(action_type) <= 64),
  created_at timestamptz not null default now(),
  unique (org_id, ref)
);
create index if not exists autonomy_outbound_org_time on autonomy_outbound (org_id, created_at);

create table if not exists autonomy_backlog (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  ref text not null check (length(ref) between 1 and 320),
  agent_key text check (length(agent_key) <= 120),
  action_type text check (length(action_type) <= 64),
  -- the routed event and handler that will run again when the hold ends (null: the next sweep picks it up)
  event_id uuid,
  queued_at timestamptz not null default now(),
  release_at timestamptz not null,
  released_at timestamptz,
  unique (org_id, ref)
);
create index if not exists autonomy_backlog_open on autonomy_backlog (org_id) where released_at is null;

do $$
declare t text;
begin
  foreach t in array array['autonomy_connects', 'autonomy_outbound', 'autonomy_backlog'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
