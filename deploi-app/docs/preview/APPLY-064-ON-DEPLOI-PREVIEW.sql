-- ============================================================================================
-- Deploi app redesign: migration 20261107000064_app_redesign, for deploi-PREVIEW ONLY.
--   Project name: deploi-preview      Project ref: bhddgjcefwasdyrrfptc
--   NEVER run on deploi-prod (makqaqzlylhckijdbjzi).
-- Paste the whole file into Supabase > deploi-preview > SQL Editor and click Run.
-- One transaction: it either all applies or nothing changes. Safe to re-run (it stops if
-- already applied).
-- Safety check: the role deploi_launch_app exists only on deploi-preview (created for the PR #18
-- preview), so on any other project this file stops before changing anything.
-- ============================================================================================
begin;

do $guard$
begin
  if not exists (select 1 from pg_roles where rolname = 'deploi_launch_app') then
    raise exception 'STOP: this is not deploi-preview (bhddgjcefwasdyrrfptc). Nothing was changed.';
  end if;
  if not exists (select 1 from _migrations where name = '20261107000063_autonomy_on_connect.sql') then
    raise exception 'STOP: 20261107000063 is not applied on this database. Nothing was changed.';
  end if;
  if exists (select 1 from _migrations where name = '20261107000064_app_redesign.sql') then
    raise exception 'Already applied: 20261107000064_app_redesign is recorded. Nothing was changed.';
  end if;
end
$guard$;

-- ---- supabase/migrations/20261107000064_app_redesign.sql (verbatim) ------------------------
-- =============================================================================
-- The redesigned logged-in app (lib/app/contract.ts): one team across agent kinds, a store/office workspace
-- switch, a per-agent autonomy level, standing instructions per agent, and the agent chat history.
--   agent_profiles        one row per organization and agent ("store:<library key>", "store:<engine agent uuid>",
--                         "office:<office agent uuid>", "pack:<pack agent key>"): its colour (from a fixed palette,
--                         assigned round-robin in the order agents are first seen, then kept), the owner's autonomy
--                         level for it (ask_first | act_then_tell | autonomous; only an explicit choice, autonomy_set_at,
--                         overrides the organization's action modes) and whether the owner paused it
--   agent_instructions    the owner's standing instructions for one agent (at most 500 characters each, ordered); the
--                         agent loop, Office runs and library runs read them (instructionsFor)
--   app_workspace_prefs   which side of the app (store | office) each person last chose, per organization
--   agent_chat_messages   the rules-only chat with one agent (agent_ref) or the whole team (agent_ref null); kept 180
--                         days by the retention pass, covered by the customer privacy export and erasure
--   office_runs.instructions  the standing instructions an Office run was given (shown with the run's proof)
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes through
-- server code (service role) after the caller's organization and role were checked.
-- Rollback: supabase/rollback/20261107000064_app_redesign.down.sql
-- =============================================================================

create table if not exists agent_profiles (
  org_id uuid not null references agencies(id) on delete cascade,
  agent_ref text not null check (agent_ref ~ '^(store|office|pack):[A-Za-z0-9_-]{1,100}$'),
  -- first-sight order within the organization (the colour is palette[seq % 6])
  seq int not null check (seq >= 0),
  color text not null check (color in ('#4F6BFF', '#FF5FA2', '#FF8A3D', '#8B5CF6', '#14B8A6', '#E0A800')),
  autonomy text not null default 'act_then_tell' check (autonomy in ('ask_first', 'act_then_tell', 'autonomous')),
  autonomy_set_by text check (length(autonomy_set_by) <= 160),
  autonomy_set_at timestamptz,
  paused_at timestamptz,
  paused_by text check (length(paused_by) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_ref),
  unique (org_id, seq)
);

create table if not exists agent_instructions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_ref text not null check (agent_ref ~ '^(store|office|pack):[A-Za-z0-9_-]{1,100}$'),
  text text not null check (length(btrim(text)) between 1 and 500),
  position int not null default 0 check (position >= 0),
  created_by text not null check (length(created_by) <= 160),
  updated_by text check (length(updated_by) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_instructions_agent on agent_instructions (org_id, agent_ref, position, created_at);

create table if not exists app_workspace_prefs (
  org_id uuid not null references agencies(id) on delete cascade,
  -- the person: their profile id, or "shopify:<shop>:<user id>" in the embedded Shopify admin
  actor_key text not null check (length(actor_key) between 1 and 200),
  workspace text not null check (workspace in ('store', 'office')),
  updated_at timestamptz not null default now(),
  primary key (org_id, actor_key)
);

create table if not exists agent_chat_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  -- null: the team chat
  agent_ref text check (agent_ref ~ '^(store|office|pack):[A-Za-z0-9_-]{1,100}$'),
  actor_key text check (length(actor_key) <= 200),
  role text not null check (role in ('owner', 'agent')),
  text text not null check (length(text) between 1 and 4000),
  intent text check (length(intent) <= 40),
  -- buttons offered with an agent message: [{ label, needsYouId, decision }]
  actions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_chat_messages_thread on agent_chat_messages (org_id, agent_ref, created_at desc);
create index if not exists agent_chat_messages_age on agent_chat_messages (created_at);

alter table office_runs add column if not exists instructions jsonb not null default '[]'::jsonb;

do $$
declare t text;
begin
  foreach t in array array['agent_profiles', 'agent_instructions', 'app_workspace_prefs', 'agent_chat_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- ---- record it in the migration ledger --------------------------------------------------------
insert into _migrations (name) values ('20261107000064_app_redesign.sql');

-- ---- check: the four new tables and the new column (this returns one row, all true) -----------
select
  to_regclass('public.agent_profiles') is not null      as agent_profiles,
  to_regclass('public.agent_instructions') is not null  as agent_instructions,
  to_regclass('public.app_workspace_prefs') is not null as app_workspace_prefs,
  to_regclass('public.agent_chat_messages') is not null as agent_chat_messages,
  exists (select 1 from information_schema.columns where table_name = 'office_runs' and column_name = 'instructions') as office_runs_instructions;

commit;
