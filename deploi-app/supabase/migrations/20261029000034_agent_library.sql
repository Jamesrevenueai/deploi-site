-- =============================================================================
-- Agent library: the merchant's plan tier, one on/off switch per library agent, auto-run grants per
-- action type, the library's work items (drafts, approvals, logged actions with proof), usage per
-- action for billing, chat transcripts and standing instructions per agent, onboarding state,
-- feedback from private-beta stores, and "build your own" agents.
-- Same RLS model as the engine: organization members read their own rows; every write goes through
-- server-side functions (service role) after an explicit check.
-- Rollback: supabase/rollback/20261029000034_agent_library.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- plan tier
-- The tier a merchant bought decides which agents can be switched on. Tier membership itself lives in
-- lib/library/agent-library.json (config, not schema), so agents can move between tiers without a migration.
alter table agencies add column if not exists plan_tier text not null default 'starter';
alter table agencies drop constraint if exists agencies_plan_tier_chk;
alter table agencies add constraint agencies_plan_tier_chk check (plan_tier in ('starter', 'growth', 'pro'));
alter table agencies add column if not exists plan_changed_at timestamptz;
-- onboarding: {"storeConnected":bool,"tierChosen":bool,"agentsSwitchedOn":bool,"completedAt":iso}
alter table agencies add column if not exists onboarding jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- switches and grants
create table if not exists library_switches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null,
  enabled boolean not null default false,
  -- the permission level the merchant chose for this agent; every agent starts at draft (or read)
  permission text not null default 'draft' check (permission in ('read', 'draft', 'act')),
  standing_instructions text not null default '' check (length(standing_instructions) <= 4000),
  settings jsonb not null default '{}'::jsonb,
  -- the engine agent this switch created (the three template-backed agents); null for library-only agents
  engine_agent_id uuid references agents(id) on delete set null,
  switched_by text,
  switched_at timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, agent_key)
);
create index if not exists library_switches_org_idx on library_switches (org_id, enabled);

-- Auto-run: the merchant grants, per agent and per action type, that the agent may act without asking.
-- Granting is explicit and logged; revoking takes effect at once.
create table if not exists library_auto_run_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null,
  action_type text not null,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  max_per_day int not null default 20 check (max_per_day between 1 and 500),
  revoked_at timestamptz,
  revoked_by text
);
create unique index if not exists library_auto_run_live on library_auto_run_grants (org_id, agent_key, action_type) where revoked_at is null;

-- ---------------------------------------------------------------- work items (the approval queue and the activity log)
-- One row per action an agent proposed or did. draft: waiting for the merchant; approved/declined: the
-- merchant decided; done: executed (by approval or auto-run) with proof; failed: tried and did not stick.
create table if not exists library_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null,
  action_type text not null,
  run_id uuid,
  title text not null,
  summary text not null default '',
  -- what the agent read to reach this: record ids, values, the rule applied; never customer message content
  evidence jsonb not null default '{}'::jsonb,
  -- the exact thing it wants to do or did: field/from/to, or the drafted text
  payload jsonb not null default '{}'::jsonb,
  mode text not null check (mode in ('read', 'draft', 'auto')),
  status text not null check (status in ('draft', 'approved', 'declined', 'done', 'failed', 'noted', 'expired')),
  status_reason text,
  -- proof of what happened: for a write, the fresh read after; for a draft, the draft itself; for a report, the facts
  proof jsonb,
  permission_basis text,
  decided_by text,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists library_actions_org_idx on library_actions (org_id, agent_key, created_at desc);
create index if not exists library_actions_queue_idx on library_actions (org_id, status) where status = 'draft';
create unique index if not exists library_actions_open_dedupe on library_actions (org_id, agent_key, action_type, (payload->>'dedupeKey')) where status = 'draft' and payload ? 'dedupeKey';

-- ---------------------------------------------------------------- usage (billing)
create table if not exists library_usage (
  id bigserial primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null,
  action_type text not null,
  action_id uuid references library_actions(id) on delete set null,
  -- estimated or measured tokens and model cost of this action
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  measured boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists library_usage_org_month on library_usage (org_id, at desc);

-- ---------------------------------------------------------------- chat
create table if not exists library_chat_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null,
  role text not null check (role in ('merchant', 'agent')),
  text text not null check (length(text) between 1 and 4000),
  -- voice: the merchant spoke it (transcribed in the browser); the agent's reply may be read aloud
  via text not null default 'text' check (via in ('text', 'voice')),
  -- what the agent did with the message: answered, created an action, saved an instruction, refused
  outcome jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists library_chat_agent_idx on library_chat_messages (org_id, agent_key, created_at desc);

-- ---------------------------------------------------------------- build your own (Pro)
create table if not exists custom_agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  job text not null check (length(trim(job)) between 1 and 2000),
  permission text not null default 'read' check (permission in ('read', 'draft', 'act')),
  enabled boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists custom_agents_org_idx on custom_agents (org_id);

-- ---------------------------------------------------------------- feedback (private beta)
create table if not exists beta_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references agencies(id) on delete set null,
  page text not null default '',
  mood text check (mood in ('happy', 'neutral', 'unhappy')),
  message text not null check (length(trim(message)) between 1 and 4000),
  created_by text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['library_switches','library_auto_run_grants','library_actions','library_usage','library_chat_messages','custom_agents','beta_feedback'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['library_switches','library_auto_run_grants','library_actions','custom_agents'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['library_switches','library_actions','custom_agents'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;
grant usage on sequence library_usage_id_seq to service_role;
-- chat text is the merchant's own words and the agent's replies: readable by the organization, never by staff
drop policy if exists library_chat_messages_org_read on library_chat_messages;
create policy library_chat_messages_org_read on library_chat_messages for select to authenticated using (org_id = current_org_id());
