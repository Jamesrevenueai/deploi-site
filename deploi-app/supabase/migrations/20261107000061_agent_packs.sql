-- =============================================================================
-- Agent packs (lib/packs): one autonomous workforce per business type, on rules and templates only.
--   pack_settings            the business type chosen at setup, the packs it turns on, and per-pack settings
--   pack_activity            what each pack agent did (one row per agent and problem: detect -> act -> verify -> proof)
--   pack_leads               new leads from email (Zillow, Apartments.com, Zumper, website forms, CRM), any pack
--   pack_messages            every outgoing message a pack agent sent or refused (with its content policy check)
--   pack_appointments        quote visits, tours and showings booked on the calendar
--   pack_crew_members        the business's own field crew (home services, office crew updates)
--   pack_work_orders         home-services jobs: quote, schedule, dispatch, done, invoiced, paid, review asked
--   leasing_companies        managing companies a leasing agent bills
--   leasing_properties       properties and their commission rule (percent of rent or flat)
--   leasing_listings         units on offer (shown by stated criteria only: fair housing)
--   leasing_placements       move-ins: tenant, unit, move-in date, rent, commission
--   leasing_invoices         one commission invoice per property and batch of move-ins
--   leasing_payments         payments received against a commission invoice (partial or full)
--   pm_vendors               property-management vendors and their trades
--   pm_maintenance_requests  maintenance requests from tenant email or the property system
--   pack_synthetic_state     the synthetic providers used in tests and demos; server only
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes
-- through server code (service role). The synthetic provider state is server only (deny-all).
-- Rollback: supabase/rollback/20261107000061_agent_packs.down.sql
-- =============================================================================

create table if not exists pack_settings (
  org_id uuid primary key references agencies(id) on delete cascade,
  business_type text not null check (business_type in ('store', 'home_services', 'leasing_agent', 'real_estate_agent', 'property_manager', 'office')),
  packs text[] not null default '{}',
  -- home services: the trade the reply templates are written for
  trade text check (trade in ('construction', 'hvac', 'roofing', 'landscaping', 'cleaning', 'general')),
  settings jsonb not null default '{}'::jsonb,
  updated_by text check (length(updated_by) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pack_activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  pack text not null check (pack in ('commerce', 'home_services', 'leasing', 'real_estate', 'property_management', 'office')),
  agent_key text not null check (length(agent_key) between 2 and 80),
  problem_key text not null check (length(problem_key) between 1 and 300),
  status text not null check (status in ('done', 'not_verified', 'waiting_for_owner', 'failed', 'blocked')),
  mode text check (mode in ('act_and_tell', 'ask_first')),
  title text not null default '' check (length(title) <= 300),
  what_happened text not null default '' check (length(what_happened) <= 2000),
  what_i_did jsonb not null default '[]'::jsonb,
  proof jsonb not null default '[]'::jsonb,
  error text check (length(error) <= 1000),
  runs int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, agent_key, problem_key)
);
create index if not exists pack_activity_org_recent on pack_activity (org_id, pack, updated_at desc);

create table if not exists pack_leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  pack text not null check (pack in ('home_services', 'leasing', 'real_estate', 'property_management', 'office')),
  source text not null default 'email' check (source in ('email', 'website', 'zillow', 'apartments_com', 'zumper', 'realtor_com', 'crm', 'buildium', 'phone', 'manual')),
  external_id text not null check (length(external_id) between 1 and 300),
  name text check (length(name) <= 160),
  email text check (length(email) <= 254),
  phone text check (length(phone) <= 40),
  -- buyer / seller (real estate), renter (leasing), service request (home services)
  intent text not null default 'inquiry' check (intent in ('inquiry', 'buyer', 'seller', 'renter', 'service')),
  subject text check (length(subject) <= 300),
  -- only the answers to the questions everyone is asked (leasing: budget, move-in date, bedrooms, pets)
  criteria jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'replied', 'qualifying', 'slots_offered', 'booked', 'quoted', 'won', 'lost', 'quiet', 'stopped', 'duplicate')),
  duplicate_of uuid references pack_leads(id) on delete set null,
  replied_at timestamptz,
  last_inbound_at timestamptz,
  follow_ups int not null default 0,
  next_follow_up_at timestamptz,
  proposed_slots jsonb not null default '[]'::jsonb,
  crm_record_id text check (length(crm_record_id) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
create index if not exists pack_leads_org_email on pack_leads (org_id, lower(email));
create index if not exists pack_leads_due on pack_leads (org_id, next_follow_up_at) where next_follow_up_at is not null;

create table if not exists pack_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null check (length(agent_key) between 2 and 80),
  lead_id uuid references pack_leads(id) on delete set null,
  to_address text not null check (length(to_address) between 3 and 254),
  subject text not null check (length(subject) <= 300),
  body text not null check (length(body) <= 20000),
  status text not null check (status in ('sent', 'blocked', 'failed')),
  -- the content policy check every outgoing message passes (or fails) before it is sent
  policy jsonb not null default '{}'::jsonb,
  provider text not null default 'synthetic' check (length(provider) <= 40),
  provider_message_id text check (length(provider_message_id) <= 300),
  error text check (length(error) <= 1000),
  dedupe_key text not null check (length(dedupe_key) between 3 and 300),
  created_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index if not exists pack_messages_org_recent on pack_messages (org_id, created_at desc);
create index if not exists pack_messages_lead on pack_messages (lead_id) where lead_id is not null;

create table if not exists pack_appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  lead_id uuid references pack_leads(id) on delete cascade,
  kind text not null check (kind in ('quote_visit', 'tour', 'showing', 'meeting')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  calendar_event_id text check (length(calendar_event_id) <= 200),
  status text not null default 'booked' check (status in ('booked', 'cancelled', 'done')),
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists pack_appointments_org_start on pack_appointments (org_id, starts_at);

create table if not exists pack_crew_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  email text check (length(email) <= 254),
  phone text check (length(phone) <= 40),
  trade text check (length(trade) <= 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pack_work_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  pack text not null default 'home_services' check (pack in ('home_services', 'office')),
  ref text not null check (length(ref) between 1 and 40),
  lead_id uuid references pack_leads(id) on delete set null,
  customer_name text check (length(customer_name) <= 160),
  customer_email text check (length(customer_email) <= 254),
  customer_phone text check (length(customer_phone) <= 40),
  address text check (length(address) <= 300),
  description text not null default '' check (length(description) <= 2000),
  amount numeric(12, 2) check (amount is null or amount >= 0),
  currency text not null default 'USD' check (length(currency) = 3),
  crew_member_id uuid references pack_crew_members(id) on delete set null,
  scheduled_start timestamptz,
  status text not null default 'quoted' check (status in ('quoted', 'accepted', 'scheduled', 'dispatched', 'confirmed', 'done', 'invoiced', 'paid', 'quiet', 'cancelled')),
  status_reason text check (length(status_reason) <= 500),
  quote_sent_at timestamptz,
  quote_follow_ups int not null default 0,
  next_quote_follow_up_at timestamptz,
  dispatched_at timestamptz,
  dispatch_reminders int not null default 0,
  crew_confirmed_at timestamptz,
  crew_escalated_at timestamptz,
  done_at timestamptz,
  invoice_external_id text check (length(invoice_external_id) <= 120),
  invoice_number text check (length(invoice_number) <= 40),
  invoiced_at timestamptz,
  invoice_due_date date,
  invoice_balance numeric(12, 2),
  payment_reminders int not null default 0,
  last_payment_reminder_at timestamptz,
  payment_escalated_at timestamptz,
  paid_at timestamptz,
  review_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, ref)
);
create index if not exists pack_work_orders_org_status on pack_work_orders (org_id, status);

create table if not exists leasing_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  billing_email text check (length(billing_email) <= 254),
  contact_name text check (length(contact_name) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leasing_properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  company_id uuid references leasing_companies(id) on delete set null,
  name text not null check (length(name) between 1 and 160),
  address text check (length(address) <= 300),
  -- where the commission invoice goes (falls back to the managing company's billing address)
  billing_email text check (length(billing_email) <= 254),
  commission_type text not null default 'percent' check (commission_type in ('percent', 'flat')),
  -- percent of one month's rent (e.g. 50.00), or a flat amount
  commission_value numeric(12, 2) not null default 0 check (commission_value >= 0),
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leasing_listings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  property_id uuid references leasing_properties(id) on delete cascade,
  unit text not null check (length(unit) between 1 and 40),
  bedrooms int not null default 0 check (bedrooms between 0 and 10),
  monthly_rent numeric(12, 2) not null check (monthly_rent >= 0),
  available_from date,
  pets_allowed boolean not null default false,
  application_url text check (length(application_url) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leasing_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  property_id uuid references leasing_properties(id) on delete set null,
  number text not null check (length(number) between 1 and 40),
  issued_on date not null default current_date,
  due_date date not null default current_date,
  currency text not null default 'USD' check (length(currency) = 3),
  total numeric(12, 2) not null default 0 check (total >= 0),
  paid_amount numeric(12, 2) not null default 0 check (paid_amount >= 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'paid', 'void')),
  bill_to text check (length(bill_to) <= 254),
  sent_at timestamptz,
  reminders int not null default 0,
  last_reminder_at timestamptz,
  escalated_at timestamptz,
  paid_at timestamptz,
  -- what was billed, as built (tenant, unit, move-in date, rent, commission per placement)
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number)
);
create index if not exists leasing_invoices_org_status on leasing_invoices (org_id, status);

create table if not exists leasing_placements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  property_id uuid references leasing_properties(id) on delete set null,
  lead_id uuid references pack_leads(id) on delete set null,
  tenant_name text not null default '' check (length(tenant_name) <= 160),
  tenant_email text check (length(tenant_email) <= 254),
  unit text not null default '' check (length(unit) <= 40),
  move_in_date date not null default current_date,
  monthly_rent numeric(12, 2) not null default 0 check (monthly_rent >= 0),
  -- the rule copied from the property when the placement was recorded (a later change to the property never rewrites it)
  commission_type text not null default 'percent' check (commission_type in ('percent', 'flat')),
  commission_value numeric(12, 2) not null default 0 check (commission_value >= 0),
  commission_amount numeric(12, 2) not null default 0 check (commission_amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'moved_in', 'invoiced', 'paid', 'cancelled')),
  invoice_id uuid references leasing_invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leasing_placements_org_status on leasing_placements (org_id, status, move_in_date);

create table if not exists leasing_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  invoice_id uuid references leasing_invoices(id) on delete cascade,
  amount numeric(12, 2) not null default 0 check (amount >= 0),
  received_on date not null default current_date,
  note text check (length(note) <= 300),
  external_id text check (length(external_id) <= 120),
  created_at timestamptz not null default now()
);
create unique index if not exists leasing_payments_external on leasing_payments (org_id, external_id) where external_id is not null;

create table if not exists pm_vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  email text check (length(email) <= 254),
  phone text check (length(phone) <= 40),
  trades text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pm_maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  source text not null default 'email' check (source in ('email', 'buildium', 'manual')),
  external_id text not null check (length(external_id) between 1 and 300),
  property text check (length(property) <= 160),
  unit text check (length(unit) <= 40),
  tenant_name text check (length(tenant_name) <= 160),
  tenant_email text check (length(tenant_email) <= 254),
  tenant_phone text check (length(tenant_phone) <= 40),
  category text not null default 'general' check (category in ('plumbing', 'electrical', 'hvac', 'appliance', 'pest', 'locks', 'general')),
  description text not null default '' check (length(description) <= 2000),
  urgency text not null default 'normal' check (urgency in ('emergency', 'normal')),
  vendor_id uuid references pm_vendors(id) on delete set null,
  declined_vendor_ids uuid[] not null default '{}',
  status text not null default 'new' check (status in ('new', 'dispatched', 'scheduled', 'fixed', 'confirmed', 'escalated', 'closed')),
  status_reason text check (length(status_reason) <= 500),
  dispatched_at timestamptz,
  vendor_accepted_at timestamptz,
  fixed_at timestamptz,
  confirmed_at timestamptz,
  tenant_updates int not null default 0,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
create index if not exists pm_maintenance_org_status on pm_maintenance_requests (org_id, status);

create table if not exists pack_synthetic_state (
  org_id uuid not null references agencies(id) on delete cascade,
  port text not null check (port in ('mail', 'calendar', 'crm', 'invoicing', 'property_system')),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, port)
);

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['pack_settings', 'pack_activity', 'pack_leads', 'pack_messages', 'pack_appointments', 'pack_crew_members', 'pack_work_orders',
      'leasing_companies', 'leasing_properties', 'leasing_listings', 'leasing_invoices', 'leasing_placements', 'leasing_payments', 'pm_vendors', 'pm_maintenance_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
    if t <> 'pack_messages' and t <> 'leasing_payments' then
      execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
      execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
    end if;
  end loop;
end $$;
-- the synthetic providers' state: server only
alter table pack_synthetic_state enable row level security;
revoke all on pack_synthetic_state from anon, authenticated;
grant all on pack_synthetic_state to service_role;
