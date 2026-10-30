-- =============================================================================
-- Email connections for named agents. A merchant connects a mailbox through the provider's OAuth
-- flow (never a password); tokens are encrypted at rest and unreadable by user sessions. Connecting
-- an account authorizes nothing by itself: each agent's policy names the account, the permission
-- level (draft / send approved / send autonomously), recipients, purpose, limits and duration.
-- Message content (subject, body, attachments) is encrypted at rest; recipients are stored in
-- clear because every send is checked against the agent's recipient rules.
-- =============================================================================

create table if not exists email_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'microsoft', 'synthetic')),
  address text not null,
  display_name text,
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'error', 'disconnected')),
  status_reason text,
  granted_scopes text[] not null default '{}',
  can_send boolean not null default false,
  can_read boolean not null default false,
  is_synthetic boolean not null default false,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  connected_by text not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists email_accounts_live_address on email_accounts (org_id, provider, lower(address)) where status <> 'disconnected';
create index if not exists email_accounts_org_idx on email_accounts (org_id, status);

create table if not exists email_credentials (
  account_id uuid primary key references email_accounts(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  key_id text not null,
  ciphertext text not null,
  refresh_ciphertext text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One-time OAuth state (CSRF + PKCE verifier), bound to the organization and the user who started it.
create table if not exists email_oauth_states (
  state text primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'microsoft', 'synthetic')),
  account_id uuid references email_accounts(id) on delete cascade,
  want_read boolean not null default false,
  key_id text not null,
  verifier_ciphertext text not null,
  created_by text not null,
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists email_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  run_id uuid references agent_runs(id) on delete set null,
  account_id uuid not null references email_accounts(id) on delete cascade,
  policy_id uuid references agent_policies(id) on delete set null,
  policy_version int,
  task_key text not null check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder')),
  dedupe_key text not null,
  status text not null check (status in ('draft', 'awaiting_approval', 'queued', 'sending', 'accepted', 'failed', 'delivery_unknown', 'cancelled')),
  status_reason text,
  from_address text not null,
  to_addresses text[] not null,
  cc_addresses text[] not null default '{}',
  attachment_count int not null default 0,
  attachment_bytes int not null default 0,
  key_id text not null,
  content_ciphertext text not null,
  content_hash text not null,
  internet_message_id text not null unique,
  -- approval: individual (a merchant user, bound to the content hash) or standing (the agent's policy version)
  approval_kind text check (approval_kind in ('individual', 'standing')),
  approved_by text,
  approved_hash text,
  approved_at timestamptz,
  qualification jsonb,
  -- sending
  attempts int not null default 0,
  next_attempt_at timestamptz,
  sending_started_at timestamptz,
  accepted_at timestamptz,
  accepted_evidence text,
  provider_message_id text,
  provider_thread_id text,
  failure_code text,
  reconcile_checks int not null default 0,
  reply_seen_at timestamptz,
  reply_count int not null default 0,
  -- non-sensitive references the message is about (e.g. variant ids for the supplier cooldown)
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, dedupe_key)
);
create index if not exists email_messages_org_idx on email_messages (org_id, created_at desc);
create index if not exists email_messages_agent_idx on email_messages (agent_id, status);
create index if not exists email_messages_queue_idx on email_messages (status, next_attempt_at) where status in ('queued', 'sending', 'delivery_unknown');
create index if not exists email_messages_account_day_idx on email_messages (account_id, accepted_at);

create table if not exists synthetic_email_state (
  account_id uuid primary key references email_accounts(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['email_accounts','email_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
  -- secrets and one-time states: service role only
  foreach t in array array['email_credentials','email_oauth_states','synthetic_email_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
-- the encrypted content column stays server-side even for org members: the API decrypts after its own checks
revoke select on email_messages from authenticated;
grant select (id, org_id, agent_id, run_id, account_id, policy_id, policy_version, task_key, status, status_reason, from_address, to_addresses, cc_addresses,
  attachment_count, attachment_bytes, content_hash, approval_kind, approved_by, approved_at, qualification, attempts, next_attempt_at, accepted_at,
  accepted_evidence, failure_code, reply_seen_at, reply_count, meta, created_at, updated_at) on email_messages to authenticated;
