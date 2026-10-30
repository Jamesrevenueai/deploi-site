-- =============================================================================
-- Agent platform: per-agent mailboxes on Deploi's own domain (no Gmail restricted scopes), inbound
-- mail with reply threading, plain-language tasks with honest statuses, and the weekly summary.
-- Same RLS model as the engine: organization members read their own rows (never message content);
-- every write goes through server-side functions (service role) after an explicit check.
-- Rollback: supabase/rollback/20261028000032_agent_platform.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- agent mailboxes
alter table email_accounts drop constraint if exists email_accounts_provider_check;
alter table email_accounts add constraint email_accounts_provider_check check (provider in ('gmail', 'microsoft', 'synthetic', 'deploi'));
-- a Deploi mailbox belongs to exactly one agent; Gmail/Microsoft/synthetic accounts belong to the organization
alter table email_accounts add column if not exists agent_id uuid references agents(id) on delete set null;
create unique index if not exists email_accounts_one_mailbox_per_agent on email_accounts (agent_id) where provider = 'deploi' and status <> 'disconnected';
-- an address on our domain is unique across every organization, live or not, so mail can never be routed to the wrong tenant
create unique index if not exists email_accounts_deploi_address on email_accounts (lower(address)) where provider = 'deploi';

alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup'));
-- threading: the message this one replies to, and the token in the Reply-To address that routes replies back
alter table email_messages add column if not exists in_reply_to text;
alter table email_messages add column if not exists reply_token text;
create unique index if not exists email_messages_reply_token on email_messages (reply_token) where reply_token is not null;

-- One row per inbound email delivered to an agent mailbox. Content (subject and text) is encrypted and
-- never readable by user sessions; it is data for the merchant to read, never an instruction to the agent.
create table if not exists email_inbound (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  account_id uuid not null references email_accounts(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  provider_email_id text not null,
  internet_message_id text,
  from_address text not null,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  -- reply (matched one of our messages), merchant_forward (a member of the organization forwarded it),
  -- merchant_cc (a member copied the agent), other (anyone else)
  classification text not null check (classification in ('reply', 'merchant_forward', 'merchant_cc', 'other')),
  -- accepted: from an allowed sender; quarantined: kept for the merchant, never shown to the agent's tasks
  status text not null check (status in ('accepted', 'quarantined')),
  status_reason text,
  thread_message_id uuid references email_messages(id) on delete set null,
  auth_results jsonb not null default '{}'::jsonb,
  key_id text not null,
  content_ciphertext text not null,
  attachment_count int not null default 0,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (account_id, provider_email_id)
);
create unique index if not exists email_inbound_message_id on email_inbound (account_id, internet_message_id) where internet_message_id is not null;
create index if not exists email_inbound_agent_idx on email_inbound (agent_id, received_at desc);

-- Webhook deliveries already handled (the provider retries with the same id): duplicates are dropped.
create table if not exists inbound_webhook_events (
  provider text not null,
  delivery_id text not null,
  event_type text not null,
  outcome text not null,
  received_at timestamptz not null default now(),
  primary key (provider, delivery_id)
);

-- ---------------------------------------------------------------- plain-language tasks
create table if not exists agent_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  text text not null check (length(trim(text)) between 1 and 2000),
  -- queued: within the agent's granted rules; needs_approval: outside them (approving starts a new grant);
  -- running; done: finished with proof; waiting_on_you: finished, but items wait for your approval;
  -- failed; refused: nothing Deploi can do; cancelled
  status text not null check (status in ('needs_approval', 'queued', 'running', 'done', 'waiting_on_you', 'failed', 'refused', 'cancelled')),
  status_reason text,
  draft jsonb not null default '{}'::jsonb,
  outside_rules jsonb not null default '[]'::jsonb,
  policy_id uuid references agent_policies(id) on delete set null,
  policy_version int,
  run_id uuid references agent_runs(id) on delete set null,
  proof jsonb,
  created_by text not null,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists agent_tasks_agent_idx on agent_tasks (agent_id, created_at desc);
create index if not exists agent_tasks_queue_idx on agent_tasks (status, created_at) where status = 'queued';

-- ---------------------------------------------------------------- weekly summary
create table if not exists weekly_summaries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  week_start date not null,
  status text not null check (status in ('prepared', 'sending', 'accepted', 'failed', 'skipped')),
  status_reason text,
  recipients text[] not null default '{}',
  -- counts only (no message content): what each agent did, what needs attention, the labelled estimate
  facts jsonb not null,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (org_id, week_start)
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['email_inbound','agent_tasks','weekly_summaries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['agent_tasks'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  -- webhook bookkeeping: service role only
  alter table inbound_webhook_events enable row level security;
  revoke all on inbound_webhook_events from anon, authenticated;
  grant all on inbound_webhook_events to service_role;
end $$;
-- inbound content stays server-side even for organization members; the API decrypts after its own checks
revoke select on email_inbound from authenticated;
grant select (id, org_id, account_id, agent_id, provider_email_id, internet_message_id, from_address, to_addresses, cc_addresses, classification, status,
  status_reason, thread_message_id, auth_results, attachment_count, received_at, created_at) on email_inbound to authenticated;
-- new email_messages columns are visible like the others (not the content)
grant select (in_reply_to, reply_token) on email_messages to authenticated;
