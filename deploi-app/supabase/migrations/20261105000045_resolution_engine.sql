-- =============================================================================
-- Resolution Engine: one durable case per business problem, from detection to a verified outcome.
-- A case links the records it is about (store issues, executions, emails, Office actions, purchase orders,
-- invoices ...), carries evidence, an owner agent, a status from one lifecycle, the next action and the
-- next check, and closes as resolved only with verification evidence. Every change is a case event.
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every write
-- goes through server functions (service role).
-- Rollback: supabase/rollback/20261105000045_resolution_engine.down.sql
-- =============================================================================
create sequence if not exists case_number_seq;

create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  -- human-readable, unique across Deploi: DC-000123
  ref text not null unique default ('DC-' || lpad(nextval('case_number_seq')::text, 6, '0')),
  suite text not null check (suite in ('commerce', 'office')),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{2,60}$'),
  -- the application the problem was found in: shopify, woocommerce, hubspot, quickbooks, deploi_email, outlook, import ...
  source_app text not null check (source_app ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- one open case per problem: re-detection updates the open case instead of opening another
  dedupe_key text not null check (length(dedupe_key) between 3 and 300),
  title text not null check (length(title) between 3 and 300),
  problem text not null check (length(problem) <= 4000),
  why_it_matters text check (length(why_it_matters) <= 2000),
  priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  status text not null default 'detected' check (status in ('detected', 'investigating', 'proposed', 'awaiting_approval', 'executing',
    'waiting_external', 'verifying', 'resolved', 'blocked', 'failed', 'cancelled', 'escalated')),
  status_reason text check (length(status_reason) <= 1000),
  -- owner: an engine agent, an Office agent or a library agent (exactly one kind); null = unassigned
  agent_kind text check (agent_kind in ('engine', 'office', 'library')),
  agent_ref text check (length(agent_ref) <= 120),
  next_action text check (length(next_action) <= 1000),
  approval_required boolean not null default false,
  next_check_at timestamptz,
  deadline_at timestamptz,
  -- what must be observed for the case to count as resolved, in plain words and as a machine rule
  verification jsonb not null default '{}'::jsonb,
  -- the verified outcome: { summary, evidence: [...], verifiedBy, verifiedAt }
  outcome jsonb,
  evidence jsonb not null default '[]'::jsonb,
  -- records this case is about: [{ type, id, label }]
  records jsonb not null default '[]'::jsonb,
  attempts int not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint cases_agent_pair check ((agent_kind is null) = (agent_ref is null)),
  constraint cases_resolved_has_outcome check (status <> 'resolved' or (outcome is not null and outcome ? 'verifiedAt'))
);
create unique index if not exists cases_open_dedupe on cases (org_id, dedupe_key) where status not in ('resolved', 'cancelled');
create index if not exists cases_org_status on cases (org_id, status, updated_at desc);
create index if not exists cases_due on cases (next_check_at) where next_check_at is not null and status not in ('resolved', 'cancelled', 'failed');
create index if not exists cases_agent on cases (org_id, agent_kind, agent_ref);

-- every change to a case: status changes, actions taken, evidence, notes, handoffs, verification
create table if not exists case_events (
  id bigserial primary key,
  case_id uuid not null references cases(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null check (length(actor) <= 160),
  type text not null check (type in ('opened', 'status', 'action', 'evidence', 'note', 'handoff', 'verification', 'redetected', 'link')),
  from_status text,
  to_status text,
  summary text not null check (length(summary) <= 1000),
  detail jsonb not null default '{}'::jsonb,
  -- the underlying record this event is about (an execution, an email message, an Office action ...)
  ref_type text check (ref_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  ref_id text check (length(ref_id) <= 120)
);
create index if not exists case_events_case on case_events (case_id, id);
create index if not exists case_events_org on case_events (org_id, at desc);

-- underlying record -> case, so a source can find the case for a record it is acting on
create table if not exists case_links (
  case_id uuid not null references cases(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  ref_type text not null check (ref_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  ref_id text not null check (length(ref_id) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (ref_type, ref_id, case_id)
);
create index if not exists case_links_case on case_links (case_id);
create index if not exists case_links_org_ref on case_links (org_id, ref_type, ref_id);

do $$ declare t text; begin
  foreach t in array array['cases', 'case_events', 'case_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
grant usage on sequence case_events_id_seq, case_number_seq to service_role;
drop trigger if exists audit_cases on cases;
create trigger audit_cases after insert or update or delete on cases for each row execute function audit_row();
drop trigger if exists touch_updated_cases on cases;
create trigger touch_updated_cases before update on cases for each row execute function set_updated_at();

-- case events are history: never edited or removed by the app (removal only with the case or the organization)
create or replace function case_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'case_events are append-only';
end $$;
drop trigger if exists case_events_no_update on case_events;
create trigger case_events_no_update before update on case_events for each row execute function case_events_append_only();
