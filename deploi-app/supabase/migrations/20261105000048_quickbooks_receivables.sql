-- =============================================================================
-- QuickBooks Online as a Deploi Office connection, and the Accounts Receivable agent.
--  * office_connections / office_oauth_states accept provider 'quickbooks' (the company's realmId is the
--    connection's external_account_id; tokens stay in office_credentials, encrypted, bound to the connection).
--  * office_agents accept kind 'accounts_receivable'.
--  * office_invoices: the overdue QuickBooks invoices an AR agent is following, one row per invoice and
--    connection. Every amount, date, number and address in it is a copy of a QuickBooks read (with the time
--    of that read); reminders are written from it and re-checked against a fresh read before sending.
--    The case (lib/cases) is resolved only when a fresh read shows the balance at zero.
-- Deploi never writes to QuickBooks (read scope use only; see docs/QUICKBOOKS-SETUP.md).
-- Same RLS model as the rest of Office: members read their organization's rows, writes are server-side.
-- Rollback: supabase/rollback/20261105000048_quickbooks_receivables.down.sql
-- =============================================================================

-- The value lists are EXTENDED, not replaced: other migrations may add providers or kinds of their own.
create or replace function pg_temp.extend_in_check(t text, c text, col text, val text) returns void language plpgsql as $$
declare def text; vals text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = t::regclass and conname = c;
  if def is null then raise exception 'constraint %.% is missing', t, c; end if;
  if position(quote_literal(val) in def) > 0 then return; end if;
  -- e.g. CHECK ((provider = ANY (ARRAY['hubspot'::text, 'google_calendar'::text])))
  vals := substring(def from 'ARRAY\[(.*)\]');
  if vals is null then raise exception 'constraint %.% is not a value list: %', t, c, def; end if;
  execute format('alter table %I drop constraint %I', t, c);
  execute format('alter table %I add constraint %I check (%I = any (array[%s, %L::text]))', t, c, col, vals, val);
end $$;
select pg_temp.extend_in_check('office_connections', 'office_connections_provider_check', 'provider', 'quickbooks');
select pg_temp.extend_in_check('office_oauth_states', 'office_oauth_states_provider_check', 'provider', 'quickbooks');
select pg_temp.extend_in_check('office_agents', 'office_agents_kind_check', 'kind', 'accounts_receivable');

-- webhook lookups: which connections belong to a QuickBooks company (realmId)
create index if not exists office_connections_quickbooks_realm on office_connections (external_account_id) where provider = 'quickbooks' and status = 'active';

create table if not exists office_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references office_agents(id) on delete cascade,
  connection_id uuid not null references office_connections(id) on delete cascade,
  realm_id text not null,
  qbo_invoice_id text not null check (qbo_invoice_id ~ '^[0-9]{1,20}$'),
  case_id uuid references cases(id) on delete set null,
  -- open: reminders on cadence; held: waiting (promise to pay, payment claimed, declined reminder);
  -- disputed / stopped: no more reminders, the owner handles it; exhausted: every reminder sent;
  -- paid: a fresh read showed balance 0; closed: voided or deleted in QuickBooks
  status text not null default 'open' check (status in ('open', 'held', 'disputed', 'stopped', 'exhausted', 'paid', 'closed')),
  status_reason text check (length(status_reason) <= 500),
  -- copies of the last QuickBooks read
  doc_number text,
  customer_id text,
  customer_name text,
  bill_email text,
  currency text,
  total_amt numeric(18, 2),
  balance numeric(18, 2),
  txn_date date,
  due_date date,
  last_read_at timestamptz,
  -- reminder cadence
  reminders_sent int not null default 0,
  last_reminder_at timestamptz,
  next_reminder_at timestamptz,
  promised_date date,
  hold_until timestamptz,
  -- the first reminder (later reminders reply in its thread) and the newest one
  thread_message_id uuid,
  last_message_id uuid,
  -- the newest office action already reflected on the case
  synced_action_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, qbo_invoice_id)
);
create index if not exists office_invoices_agent_idx on office_invoices (agent_id, status);
create index if not exists office_invoices_org_idx on office_invoices (org_id, status);
create index if not exists office_invoices_case_idx on office_invoices (case_id);

alter table office_invoices enable row level security;
drop policy if exists office_invoices_org_read on office_invoices;
create policy office_invoices_org_read on office_invoices for select to authenticated using (is_staff() or org_id = current_org_id());
revoke all on office_invoices from anon, authenticated;
grant select on office_invoices to authenticated;
grant all on office_invoices to service_role;
drop trigger if exists audit_office_invoices on office_invoices;
create trigger audit_office_invoices after insert or update or delete on office_invoices for each row execute function audit_row();
drop trigger if exists touch_updated_office_invoices on office_invoices;
create trigger touch_updated_office_invoices before update on office_invoices for each row execute function set_updated_at();
