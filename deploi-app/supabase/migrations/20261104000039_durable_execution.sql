-- =============================================================================
-- Durable execution and shared AI infrastructure:
--  1. jobs: a Postgres-backed job queue (claimed with FOR UPDATE SKIP LOCKED, leases, backoff,
--     dead-letter, per-organization idempotency keys, cancellation by organization or agent).
--  2. org_controls: the organization-level "stop all agents" switch.
--  3. cron_heartbeats: when each scheduled job last ran (health endpoint; no tenant data).
--  4. email_suppressions: addresses that bounced, complained or unsubscribed; never sent to again.
--  5. email_thread_state: the customer inbox's read/unread and assignment per thread.
--  6. email_inbound: attachment metadata (never content) and auto-reply (loop protection) flags;
--     email_messages: 'human_reply' task (a person replying from the inbox through the same send path).
--  7. engine_audit: a tamper-evident hash chain per organization (prev_hash, row_hash, chain_seq),
--     linked by a deferred trigger at commit, with verify_engine_audit_chain(org).
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every
-- write goes through server functions (service role).
-- Rollback: supabase/rollback/20261104000039_durable_execution.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. jobs
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  org_id uuid references agencies(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 1 and 300),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 50),
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  lease_owner text,
  last_error text,
  result jsonb,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- one job per (organization, kind, idempotency key), whatever its status: a repeated enqueue returns the first
create unique index if not exists jobs_idempotency on jobs (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, idempotency_key) where idempotency_key is not null;
create index if not exists jobs_due_idx on jobs (run_after) where status = 'queued';
create index if not exists jobs_lease_idx on jobs (lease_until) where status = 'running';
create index if not exists jobs_org_idx on jobs (org_id, status);
create index if not exists jobs_agent_idx on jobs (agent_id) where status in ('queued', 'running');

-- ---------------------------------------------------------------- 2. org controls (kill switch)
create table if not exists org_controls (
  org_id uuid primary key references agencies(id) on delete cascade,
  agents_stopped boolean not null default false,
  stop_reason text,
  stopped_by text,
  stopped_at timestamptz,
  resumed_by text,
  resumed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 3. cron heartbeats
create table if not exists cron_heartbeats (
  job_key text primary key check (job_key ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  last_run_at timestamptz not null,
  last_status text not null,
  detail jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------- 4. suppressions
create table if not exists email_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  address text not null check (address = lower(address) and length(address) between 3 and 254),
  reason text not null check (reason in ('bounced', 'complained', 'unsubscribed', 'manual')),
  source_message_id uuid references email_messages(id) on delete set null,
  detail text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, address)
);

-- ---------------------------------------------------------------- 5. customer inbox thread state
create table if not exists email_thread_state (
  org_id uuid not null references agencies(id) on delete cascade,
  thread_key text not null check (thread_key ~ '^[mi]:[0-9a-f-]{36}$'),
  read_at timestamptz,
  read_by text,
  assigned_agent_id uuid references agents(id) on delete set null,
  assigned_by text,
  assigned_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, thread_key)
);

-- ---------------------------------------------------------------- 6. email columns
-- attachments are kept as metadata only (filename, type, size); their content is never stored or opened
alter table email_inbound add column if not exists attachments jsonb not null default '[]'::jsonb;
-- auto-replies (Auto-Submitted, Precedence, mailer-daemon, ...) are flagged and never count as a reply
alter table email_inbound add column if not exists auto_reply boolean not null default false;
alter table email_inbound add column if not exists auto_reply_reason text;
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'human_reply'));
-- the inbox reads these under RLS (never the content columns)
grant select (attachments, auto_reply, auto_reply_reason) on email_inbound to authenticated;
grant select (internet_message_id) on email_messages to authenticated;
create index if not exists email_messages_org_day_idx on email_messages (org_id, sending_started_at) where status in ('sending', 'accepted', 'delivery_unknown');

-- ---------------------------------------------------------------- RLS for the new tables
do $$
declare t text;
begin
  foreach t in array array['jobs', 'org_controls', 'email_suppressions', 'email_thread_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['jobs', 'org_controls', 'email_thread_state'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
  foreach t in array array['org_controls', 'email_suppressions'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
end $$;
alter table cron_heartbeats enable row level security;
drop policy if exists cron_heartbeats_staff on cron_heartbeats;
create policy cron_heartbeats_staff on cron_heartbeats for select to authenticated using (is_staff());
revoke all on cron_heartbeats from anon, authenticated;
grant select on cron_heartbeats to authenticated;
grant all on cron_heartbeats to service_role;

-- ---------------------------------------------------------------- 7. tamper-evident audit chain
alter table engine_audit add column if not exists chain_seq bigint;
alter table engine_audit add column if not exists prev_hash text;
alter table engine_audit add column if not exists row_hash text;
create unique index if not exists engine_audit_chain_idx on engine_audit (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), chain_seq) where chain_seq is not null;

-- the head of each organization's chain ('global' for rows without an organization)
create table if not exists engine_audit_chain (
  chain_key text primary key,
  seq bigint not null default 0,
  last_hash text,
  updated_at timestamptz not null default now()
);
alter table engine_audit_chain enable row level security;
revoke all on engine_audit_chain from anon, authenticated, service_role;

-- the hash of one row: its content, its place in the chain and the previous row's hash
create or replace function engine_audit_row_hash(p_prev text, p_seq bigint, r engine_audit) returns text
language sql stable set search_path = public as $$
  select encode(sha256(convert_to(concat_ws('|',
    coalesce(p_prev, 'genesis'), p_seq::text, r.id::text, coalesce(r.org_id::text, ''), coalesce(r.connection_id::text, ''),
    r.entity_type, coalesce(r.entity_id, ''), r.event, r.actor, r.detail::text,
    to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex')
$$;

-- linked at commit (deferred), so the chain head is locked only for the instant before commit and a
-- long transaction never holds it; the chain order is commit order
create or replace function engine_audit_chain_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k text := coalesce(new.org_id::text, 'global');
  r engine_audit;
  s bigint;
  ph text;
  h text;
begin
  select * into r from engine_audit where id = new.id;
  if not found or r.row_hash is not null then return null; end if;
  insert into engine_audit_chain (chain_key) values (k) on conflict (chain_key) do nothing;
  select seq, last_hash into s, ph from engine_audit_chain where chain_key = k for update;
  s := s + 1;
  h := engine_audit_row_hash(ph, s, r);
  perform set_config('deploi.audit_chain', 'on', true);
  update engine_audit set chain_seq = s, prev_hash = ph, row_hash = h where id = new.id;
  perform set_config('deploi.audit_chain', 'off', true);
  update engine_audit_chain set seq = s, last_hash = h, updated_at = now() where chain_key = k;
  return null;
end $$;
drop trigger if exists engine_audit_chain_link on engine_audit;
create constraint trigger engine_audit_chain_link after insert on engine_audit deferrable initially deferred
  for each row execute function engine_audit_chain_link();

-- append-only: the only update ever allowed is the one-time chain link above
create or replace function engine_audit_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('deploi.audit_chain', true), '') = 'on' and old.row_hash is null
     and (old.id, old.org_id, old.connection_id, old.entity_type, old.entity_id, old.event, old.actor, old.detail, old.at)
         is not distinct from (new.id, new.org_id, new.connection_id, new.entity_type, new.entity_id, new.event, new.actor, new.detail, new.at) then
    return new;
  end if;
  raise exception 'engine_audit is append-only';
end $$;
drop trigger if exists engine_audit_guard on engine_audit;
create trigger engine_audit_guard before update on engine_audit for each row execute function engine_audit_guard();

-- link the rows written before this migration, oldest first
do $$
declare r engine_audit; k text; s bigint; ph text; h text;
begin
  perform set_config('deploi.audit_chain', 'on', true);
  for r in select * from engine_audit where row_hash is null order by id loop
    k := coalesce(r.org_id::text, 'global');
    insert into engine_audit_chain (chain_key) values (k) on conflict (chain_key) do nothing;
    select seq, last_hash into s, ph from engine_audit_chain where chain_key = k;
    s := s + 1;
    h := engine_audit_row_hash(ph, s, r);
    update engine_audit set chain_seq = s, prev_hash = ph, row_hash = h where id = r.id;
    update engine_audit_chain set seq = s, last_hash = h, updated_at = now() where chain_key = k;
  end loop;
  perform set_config('deploi.audit_chain', 'off', true);
end $$;

-- walk one organization's chain: a changed row, a removed row or a broken link is reported with where it is
create or replace function verify_engine_audit_chain(p_org uuid)
returns table (ok boolean, checked bigint, broken_seq bigint, broken_id bigint, reason text)
language plpgsql stable security definer set search_path = public as $$
declare
  r engine_audit;
  expect bigint := 0;
  prev text := null;
  head_seq bigint;
begin
  for r in select * from engine_audit e where e.org_id is not distinct from p_org and e.chain_seq is not null order by e.chain_seq loop
    expect := expect + 1;
    if r.chain_seq <> expect then
      return query select false, expect - 1, expect, r.id, 'a row is missing from the chain'; return;
    end if;
    if r.prev_hash is distinct from prev then
      return query select false, expect - 1, expect, r.id, 'the link to the previous row is broken'; return;
    end if;
    if r.row_hash is distinct from engine_audit_row_hash(r.prev_hash, r.chain_seq, r) then
      return query select false, expect - 1, expect, r.id, 'the row was changed after it was written'; return;
    end if;
    prev := r.row_hash;
  end loop;
  select c.seq into head_seq from engine_audit_chain c where c.chain_key = coalesce(p_org::text, 'global');
  if head_seq is not null and head_seq <> expect then
    return query select false, expect, expect + 1, null::bigint, 'rows are missing from the end of the chain'; return;
  end if;
  return query select true, expect, null::bigint, null::bigint, null::text;
end $$;
revoke all on function verify_engine_audit_chain(uuid) from public;
grant execute on function verify_engine_audit_chain(uuid) to service_role;
