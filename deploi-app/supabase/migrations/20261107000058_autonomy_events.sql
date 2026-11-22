-- =============================================================================
-- Autonomy, events and undo (launch workstream W1):
--   1. org_action_modes  the owner's setting per action type: 'act_and_tell' (default when no row) or
--                        'ask_first' (lib/autonomy). Every change is audited.
--   2. agent_events      every trigger (Shopify webhook, mail, CRM/QuickBooks/Buildium change, crew reply, the
--                        15-minute sweep) as one row, deduplicated by (source, organization, external id); a
--                        duplicate delivery only bumps the counter. Handler outcomes are recorded per agent.
--   3. agent_loops       one row per problem an agent is working on (the agent loop, lib/events/loop.ts):
--                        who owns it, the mode, the exact action shown to the owner, approval, reminders,
--                        escalation, attempts and the case that carries it. One open loop per problem.
--   4. undo_tokens       single-use, expiring undo links (/undo/<token>); only the SHA-256 of the token is kept.
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes
-- through server functions (service role). The undo token hash is never readable by user roles.
-- Rollback: supabase/rollback/20261107000058_autonomy_events.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. autonomy modes
create table if not exists org_action_modes (
  org_id uuid not null references agencies(id) on delete cascade,
  action_type text not null check (action_type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  mode text not null check (mode in ('act_and_tell', 'ask_first')),
  updated_by text not null check (length(updated_by) between 1 and 160),
  updated_at timestamptz not null default now(),
  primary key (org_id, action_type)
);

-- ---------------------------------------------------------------- 2. events
create table if not exists agent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  source text not null check (source in ('shopify', 'outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox', 'sweep', 'crew', 'manual')),
  type text not null check (type ~ '^[a-z][a-z0-9_./:-]{0,79}$'),
  external_id text not null check (length(external_id) between 1 and 300),
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  -- routed: jobs queued for its handlers; no_handlers: nobody listens to the type; refused: the organization stopped its agents
  status text not null default 'routed' check (status in ('routed', 'no_handlers', 'refused')),
  handlers text[] not null default '{}',
  -- per agent key: { status: running|succeeded|failed, attempts, error, at }
  outcomes jsonb not null default '{}'::jsonb,
  duplicates int not null default 0 check (duplicates >= 0),
  last_duplicate_at timestamptz,
  unique (source, org_id, external_id)
);
create index if not exists agent_events_org_recent on agent_events (org_id, received_at desc);

-- ---------------------------------------------------------------- 3. agent loops
create table if not exists agent_loops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  case_id uuid references cases(id) on delete cascade,
  agent_key text not null check (length(agent_key) between 1 and 120),
  agent_name text not null default '' check (length(agent_name) <= 160),
  action_type text not null check (length(action_type) between 1 and 64),
  problem_key text not null check (length(problem_key) between 1 and 300),
  mode text not null default 'act_and_tell' check (mode in ('act_and_tell', 'ask_first')),
  state text not null default 'acting' check (state in ('acting', 'awaiting_owner', 'approved', 'blocked', 'done', 'rejected', 'cleared', 'failed')),
  -- exactly what the owner is shown (title, what happened, what the agent will do or did)
  action jsonb not null default '{}'::jsonb,
  asked_at timestamptz,
  reminded_at timestamptz,
  escalated_at timestamptz,
  decided_by text check (length(decided_by) <= 160),
  decided_at timestamptz,
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (length(last_error) <= 1000),
  next_retry_at timestamptz,
  undo_token_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one open loop per problem: a second agent (or a second run) finds it and stops
create unique index if not exists agent_loops_one_open on agent_loops (org_id, problem_key) where state in ('acting', 'awaiting_owner', 'approved', 'blocked');
create index if not exists agent_loops_case on agent_loops (case_id);
create index if not exists agent_loops_org_recent on agent_loops (org_id, updated_at desc);

-- ---------------------------------------------------------------- 4. undo tokens
create table if not exists undo_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  payload jsonb not null default '{}'::jsonb,
  summary text not null default '' check (length(summary) <= 500),
  case_id uuid references cases(id) on delete set null,
  agent_key text check (length(agent_key) <= 120),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by text check (length(used_by) <= 160),
  result jsonb
);
create index if not exists undo_tokens_org on undo_tokens (org_id, created_at desc);

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['org_action_modes', 'agent_events', 'agent_loops', 'undo_tokens'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
-- the undo token hash is a bearer secret's fingerprint: server only
revoke select on undo_tokens from authenticated;
grant select (id, org_id, kind, payload, summary, case_id, agent_key, created_at, expires_at, used_at, used_by, result) on undo_tokens to authenticated;
