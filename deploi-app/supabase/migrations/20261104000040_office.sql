-- =============================================================================
-- Deploi Office: HubSpot CRM and Google Calendar connections, office agents with versioned permission
-- policies, leads in follow-up, meetings, and every consequential action (send email, create / patch /
-- delete a calendar event, write to the CRM) as one office_actions row with a unique idempotency key.
-- Same RLS model as the engine: organization members read their own rows, staff read all, every write
-- goes through server-side functions (service role) after an explicit authorization check. Credentials
-- and OAuth states are unreadable from any user session.
-- Office is gated by org_products (product 'office'), not by org_type.
-- Rollback: supabase/rollback/20261104000040_office.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- connections
create table if not exists office_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('hubspot', 'google_calendar')),
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'disconnected')),
  status_reason text,
  -- synthetic connections are test/demo providers kept entirely inside Deploi; never mixed with real ones
  is_synthetic boolean not null default false,
  -- HubSpot: portal (hub) id; Google: the signed-in account's address
  external_account_id text not null,
  display_name text,
  scopes text[] not null default '{}',
  -- Google Calendar: which calendar is read and written ('primary'), and its time zone
  calendar_id text,
  timezone text,
  connected_by text not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists office_connections_one_live on office_connections (org_id, provider) where status <> 'disconnected';
create index if not exists office_connections_org_idx on office_connections (org_id, status);

-- encrypted tokens (AES-256-GCM, the connection id is the additional authenticated data)
create table if not exists office_credentials (
  connection_id uuid primary key references office_connections(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  key_id text not null,
  ciphertext text not null,
  refresh_ciphertext text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- one-time OAuth states, bound to the organization and the user who started the attempt; expire in 10 minutes
create table if not exists office_oauth_states (
  state text primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('hubspot', 'google_calendar')),
  created_by text not null,
  key_id text,
  verifier_ciphertext text,
  return_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists office_oauth_states_org_idx on office_oauth_states (org_id);

-- ---------------------------------------------------------------- agents and policies
create table if not exists office_agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  kind text not null check (kind in ('lead_followup', 'meeting_scheduler', 'crm_updater', 'customer_reply')),
  name text not null check (length(trim(name)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'revoked', 'deleted')),
  active_policy_id uuid,
  next_run_at timestamptz,
  last_run_at timestamptz,
  -- HubSpot leads are read from this time on (with the policy's look-back on the first poll)
  last_polled_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_agents_org_idx on office_agents (org_id, status);
create index if not exists office_agents_due_idx on office_agents (next_run_at) where status = 'active';

create table if not exists office_agent_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  version int not null,
  policy jsonb not null,
  policy_hash text not null,
  summary jsonb not null default '{}'::jsonb,
  status text not null default 'pending_grant' check (status in ('pending_grant', 'active', 'superseded', 'revoked', 'discarded')),
  requires_grant boolean not null default true,
  expansion jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  granted_by text,
  granted_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  unique (agent_id, version)
);
create unique index if not exists office_agent_policies_one_active on office_agent_policies (agent_id) where status = 'active';
alter table office_agents drop constraint if exists office_agents_active_policy_fk;
alter table office_agents add constraint office_agents_active_policy_fk foreign key (active_policy_id) references office_agent_policies(id) on delete set null;

create table if not exists office_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  policy_id uuid references office_agent_policies(id) on delete set null,
  policy_version int,
  trigger text not null check (trigger in ('manual', 'schedule', 'test')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'blocked')),
  status_reason text,
  counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists office_runs_agent_idx on office_runs (agent_id, started_at desc);

-- ---------------------------------------------------------------- leads, meetings, actions
create table if not exists office_leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  hubspot_contact_id text not null,
  email text not null,
  first_name text,
  company text,
  lifecycle_stage text,
  status text not null default 'active' check (status in ('active', 'replied', 'stopped', 'completed')),
  stop_reason text,
  touches int not null default 0,
  last_touch_at timestamptz,
  next_touch_at timestamptz,
  -- the first message of the thread (follow-ups reply to it) and the newest one
  thread_message_id uuid,
  last_message_id uuid,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, hubspot_contact_id)
);
create index if not exists office_leads_due_idx on office_leads (agent_id, next_touch_at) where status = 'active';
create index if not exists office_leads_org_idx on office_leads (org_id, status);

create table if not exists office_meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  lead_id uuid references office_leads(id) on delete set null,
  contact_email text not null,
  hubspot_contact_id text,
  status text not null default 'proposing' check (status in ('proposing', 'proposed', 'booking', 'booked', 'cancelled', 'failed')),
  status_reason text,
  proposed_slots jsonb not null default '[]'::jsonb,
  chosen_slot jsonb,
  -- the email thread the proposal went out in (the reply that picks a slot comes back on it)
  proposal_message_id uuid,
  calendar_event_id text,
  calendar_link text,
  meet_link text,
  source_inbound_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_meetings_org_idx on office_meetings (org_id, status);
create unique index if not exists office_meetings_source on office_meetings (agent_id, source_inbound_id) where source_inbound_id is not null;

create table if not exists office_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  policy_id uuid references office_agent_policies(id) on delete set null,
  policy_version int,
  kind text not null check (kind in ('send_email', 'create_event', 'patch_event', 'delete_event', 'crm_note', 'crm_task', 'crm_update_contact', 'crm_deal_stage')),
  purpose text not null,
  -- one consequential action per key: retries, overlapping runs and repeated inbound mail can never create a second one
  idempotency_key text not null,
  status text not null check (status in ('draft', 'awaiting_approval', 'queued', 'executing', 'succeeded', 'failed', 'unknown', 'cancelled', 'rejected')),
  status_reason text,
  -- the exact email, event or CRM change; what an approval is bound to (payload_hash)
  payload jsonb not null,
  payload_hash text not null,
  approval_kind text check (approval_kind in ('individual', 'standing')),
  approved_by text,
  approved_hash text,
  approved_at timestamptz,
  qualification jsonb,
  lead_id uuid references office_leads(id) on delete set null,
  meeting_id uuid references office_meetings(id) on delete set null,
  email_message_id uuid references email_messages(id) on delete set null,
  external_id text,
  result jsonb,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  executing_started_at timestamptz,
  executed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index if not exists office_actions_queue_idx on office_actions (org_id, status, next_attempt_at) where status in ('queued', 'executing', 'unknown');
create index if not exists office_actions_agent_idx on office_actions (agent_id, status);
create index if not exists office_actions_pending_idx on office_actions (org_id, created_at desc) where status = 'awaiting_approval';

-- inbound mail an office agent has already looked at (each message is handled once per agent)
create table if not exists office_inbound_handled (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  inbound_id uuid not null references email_inbound(id) on delete cascade,
  classification text not null,
  outcome text not null,
  created_at timestamptz not null default now(),
  unique (agent_id, inbound_id)
);

-- per-organization lease so overlapping scheduler calls never process one organization twice at once
create table if not exists office_org_locks (
  org_id uuid primary key references agencies(id) on delete cascade,
  locked_until timestamptz not null default now(),
  locked_by text,
  last_run_at timestamptz
);

-- synthetic HubSpot and Google Calendar state (tests and demos only)
create table if not exists office_synthetic_state (
  connection_id uuid primary key references office_connections(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- email engine links
-- Office messages go through the same email engine (review, approval binding, live-send gate,
-- one send per row, reconciliation). They carry the office agent and action instead of a store agent.
alter table email_messages add column if not exists office_agent_id uuid references office_agents(id) on delete set null;
alter table email_messages add column if not exists office_action_id uuid references office_actions(id) on delete set null;
create unique index if not exists email_messages_office_dedupe on email_messages (office_agent_id, dedupe_key) where office_agent_id is not null;
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'office'));
grant select (office_agent_id, office_action_id) on email_messages to authenticated;
-- an organization's Deploi Office mailbox (an agent mailbox on Deploi's domain that belongs to no store agent)
alter table email_accounts add column if not exists office_mailbox boolean not null default false;

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['office_connections','office_agents','office_agent_policies','office_runs','office_leads','office_meetings','office_actions','office_inbound_handled'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  -- secrets, one-time states, locks and synthetic provider state: no policy and no grant for user sessions
  foreach t in array array['office_credentials','office_oauth_states','office_org_locks','office_synthetic_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['office_connections','office_agents','office_agent_policies','office_actions','office_meetings'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['office_connections','office_agents','office_leads','office_meetings','office_actions'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;
-- the exact email text and event details are read through the server (after the organization check), not by user sessions
revoke select on office_actions from authenticated;
grant select (id, org_id, agent_id, policy_id, policy_version, kind, purpose, status, status_reason, payload_hash, approval_kind, approved_by, approved_at,
  lead_id, meeting_id, email_message_id, external_id, attempts, next_attempt_at, executed_at, verified_at, created_at, updated_at) on office_actions to authenticated;
