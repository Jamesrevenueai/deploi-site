-- =============================================================================
-- Inbox reading for Email Operations: Gmail and Microsoft 365 inboxes (with the owner's read permission),
-- and a safe first-contact policy for the Deploi office mailbox.
--  * email_sync_state: one row per connected Gmail / Outlook account whose inbox is read. The cursor is the
--    Gmail historyId or the Graph deltaLink (no secret in either; tokens stay in email_credentials). Push
--    (Gmail users.watch, Graph subscriptions) is optional and behind configuration; polling is the default.
--    The Graph subscription's clientState is stored only as a SHA-256 hash.
--  * email_inbound gains: provider_thread_id (Gmail threadId, Graph conversationId) and provider_message_id
--    for replying in the provider's own thread; first_contact (a sender the organization never wrote to);
--    quarantine_code (a stable reason code shown in the inbox); released_by / released_at (the owner let a
--    quarantined message through); answered_at (the owner answered it outside Deploi, seen in Sent mail).
--  * email_sender_rules: per organization, an owner's blocklist ('block', an address or @domain) and the
--    senders whose first reply the owner approved ('trusted'). Only owners and admins change it.
--  * email_oauth_states.want_inbox: the connect flow asks for inbox reading (gmail.readonly / Mail.Read) only
--    when the owner turned on "read my inbox" for an Email Operations agent.
-- Same RLS model as the rest of email: members read their organization's rows, writes are server-side.
-- Rollback: supabase/rollback/20261106000054_inbox_reading.down.sql
-- =============================================================================

alter table email_inbound add column if not exists provider_thread_id text;
alter table email_inbound add column if not exists provider_message_id text;
alter table email_inbound add column if not exists first_contact boolean not null default false;
alter table email_inbound add column if not exists quarantine_code text check (quarantine_code is null or quarantine_code ~ '^[a-z_]{1,40}$');
alter table email_inbound add column if not exists released_by text check (length(released_by) <= 160);
alter table email_inbound add column if not exists released_at timestamptz;
alter table email_inbound add column if not exists answered_at timestamptz;
create index if not exists email_inbound_thread_idx on email_inbound (account_id, provider_thread_id) where provider_thread_id is not null;
create index if not exists email_inbound_first_contact_idx on email_inbound (account_id, lower(from_address), received_at) where first_contact;
grant select (provider_thread_id, first_contact, quarantine_code, released_by, released_at, answered_at) on email_inbound to authenticated;

alter table email_oauth_states add column if not exists want_inbox boolean not null default false;

create table if not exists email_sync_state (
  account_id uuid primary key references email_accounts(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'microsoft', 'synthetic')),
  -- Gmail: the last historyId processed; Microsoft: the inbox deltaLink
  cursor text check (length(cursor) <= 4000),
  -- Microsoft: the Sent Items deltaLink (to notice replies the owner sent outside Deploi)
  sent_cursor text check (length(sent_cursor) <= 4000),
  status text not null default 'idle' check (status in ('idle', 'ok', 'backoff', 'needs_reauth', 'error')),
  last_sync_at timestamptz,
  last_full_sync_at timestamptz,
  last_error_code text check (length(last_error_code) <= 60),
  last_error_at timestamptz,
  failures int not null default 0,
  backoff_until timestamptz,
  messages_stored int not null default 0,
  -- one sync at a time per account
  lease_until timestamptz,
  -- optional push: Gmail watch expiry, Graph subscription id / expiry and the clientState hash
  push_kind text check (push_kind in ('gmail_watch', 'graph_subscription')),
  push_id text check (length(push_id) <= 200),
  push_expires_at timestamptz,
  push_secret_hash text check (push_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_sync_state_push_idx on email_sync_state (push_id) where push_id is not null;

create table if not exists email_sender_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  kind text not null check (kind in ('block', 'trusted')),
  -- an address (a@b.example) or a whole domain (@b.example), lower case
  pattern text not null check (pattern ~ '^([^@\s]+@|@)[a-z0-9.-]+\.[a-z0-9-]+$' and length(pattern) <= 254),
  reason text check (length(reason) <= 300),
  source_ref text check (length(source_ref) <= 100),
  created_by text not null check (length(created_by) <= 160),
  created_at timestamptz not null default now(),
  unique (org_id, kind, pattern)
);

do $$
declare t text;
begin
  foreach t in array array['email_sync_state', 'email_sender_rules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
-- the push secret hash stays server-side
revoke select on email_sync_state from authenticated;
grant select (account_id, org_id, provider, status, last_sync_at, last_full_sync_at, last_error_code, last_error_at, failures, backoff_until, messages_stored, push_kind, push_expires_at, created_at, updated_at)
  on email_sync_state to authenticated;
