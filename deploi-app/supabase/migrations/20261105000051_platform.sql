-- =============================================================================
-- Commercial and security platform:
--   1. AI gateway metering: ai_usage (every model call, refused or not), ai_budget_overrides
--   2. workflow execution cost counters: workflow_costs (job runs, provider API calls, emails sent)
--   3. configurable pricing: plans (+ plan_changes audit), agencies.plan_key
--   4. organization roles (closes SECURITY-REVIEW F-08): profiles.org_role, invites.org_role,
--      agencies.members_can_approve
--   5. account deletion and data retention: org_deletion_requests, agencies.deleted_at / retention,
--      body_purged_at on stored email content
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every write
-- goes through server functions (service role). plans and plan_changes are staff-only.
-- Rollback: supabase/rollback/20261105000051_platform.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. AI usage
create table if not exists ai_usage (
  id bigserial primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  -- engine:<uuid>, office:<uuid>, library:<key>, or a workflow name; never a person
  agent_ref text not null check (length(agent_ref) between 1 and 120),
  case_id uuid,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  tier text not null check (tier in ('routine', 'complex')),
  model text not null check (length(model) between 1 and 120),
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  -- reserved before the call (estimate), replaced by the measured cost after it
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms int check (latency_ms >= 0),
  outcome text not null check (outcome in ('pending', 'ok', 'refused', 'provider_error', 'invalid_output')),
  reason text check (length(reason) <= 300),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_usage_org_month on ai_usage (org_id, created_at desc);
create index if not exists ai_usage_agent_recent on ai_usage (org_id, agent_ref, created_at desc);
create index if not exists ai_usage_case_recent on ai_usage (case_id, created_at desc) where case_id is not null;

-- staff-set monthly budgets that replace the plan's (agent_ref '' = the whole organization)
create table if not exists ai_budget_overrides (
  org_id uuid not null references agencies(id) on delete cascade,
  agent_ref text not null default '' check (length(agent_ref) <= 120),
  monthly_usd numeric(10, 2) not null check (monthly_usd >= 0),
  set_by text not null check (length(set_by) <= 160),
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_ref)
);

-- ---------------------------------------------------------------- 2. workflow cost counters
create table if not exists workflow_costs (
  org_id uuid not null references agencies(id) on delete cascade,
  month date not null,
  metric text not null check (metric in ('job_run', 'provider_call', 'email_sent')),
  -- the connector for provider calls (shopify, woocommerce, hubspot ...); '' otherwise
  connector text not null default '' check (connector = '' or connector ~ '^[a-z][a-z0-9_]{1,40}$'),
  count bigint not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, month, metric, connector)
);

-- ---------------------------------------------------------------- 3. plans
create table if not exists plans (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  suite text not null check (suite in ('office', 'commerce', 'both')),
  display_name text not null check (length(display_name) between 1 and 80),
  monthly_price_cents int not null check (monthly_price_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  stripe_price_id text check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  -- the agent-library tier whose agents the plan includes
  tier_key text not null check (tier_key in ('starter', 'growth', 'pro')),
  -- { maxAgents, monthlyActions, monthlyEmails, officeSeats, officeConnections, maxCompetitorStores, aiBudgetUsd, aiAgentBudgetUsd }
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits) = 'object'),
  trial_days int not null default 0 check (trial_days between 0 and 90),
  active boolean not null default true,
  -- hypothesis: a proposal; never sold through live Stripe checkout until the owner approves it
  status text not null default 'hypothesis' check (status in ('hypothesis', 'approved', 'retired')),
  version int not null default 1 check (version >= 1),
  approved_by text,
  approved_at timestamptz,
  updated_by text not null default 'migration',
  updated_at timestamptz not null default now(),
  constraint plans_approved_has_approver check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create table if not exists plan_changes (
  id bigserial primary key,
  plan_key text not null references plans(key) on delete cascade,
  version int not null,
  actor text not null check (length(actor) <= 160),
  change jsonb not null,
  at timestamptz not null default now()
);

-- seeded hypotheses (the brief's suites) and the existing tiers with their current limits
insert into plans (key, suite, display_name, monthly_price_cents, tier_key, limits, trial_days, status) values
  ('starter', 'commerce', 'Starter', 2900, 'starter', '{"maxAgents":5,"maxCompetitorStores":5,"monthlyActions":150,"monthlyEmails":200,"officeSeats":2,"officeConnections":2,"aiBudgetUsd":5}', 0, 'hypothesis'),
  ('growth', 'commerce', 'Growth', 7900, 'growth', '{"maxAgents":12,"maxCompetitorStores":15,"monthlyActions":500,"monthlyEmails":1000,"officeSeats":5,"officeConnections":5,"aiBudgetUsd":12}', 0, 'hypothesis'),
  ('pro', 'commerce', 'Pro', 19900, 'pro', '{"maxAgents":30,"maxCompetitorStores":50,"monthlyActions":1500,"monthlyEmails":5000,"officeSeats":15,"officeConnections":15,"aiBudgetUsd":30}', 0, 'hypothesis'),
  ('office_starter', 'office', 'Office Starter', 14900, 'starter', '{"maxAgents":3,"maxCompetitorStores":0,"monthlyActions":400,"monthlyEmails":1000,"officeSeats":3,"officeConnections":3,"aiBudgetUsd":15}', 14, 'hypothesis'),
  ('commerce_operations', 'commerce', 'Commerce Operations', 29900, 'growth', '{"maxAgents":12,"maxCompetitorStores":15,"monthlyActions":1000,"monthlyEmails":2000,"officeSeats":2,"officeConnections":2,"aiBudgetUsd":30}', 14, 'hypothesis'),
  ('business_workforce', 'both', 'Business Workforce', 49900, 'pro', '{"maxAgents":30,"maxCompetitorStores":50,"monthlyActions":3000,"monthlyEmails":5000,"officeSeats":10,"officeConnections":10,"aiBudgetUsd":40}', 14, 'hypothesis')
on conflict (key) do nothing;

alter table agencies add column if not exists plan_key text references plans(key) on delete set null;

-- ---------------------------------------------------------------- 4. organization roles (F-08)
alter table profiles add column if not exists org_role text;
alter table profiles drop constraint if exists profiles_org_role_chk;
alter table profiles add constraint profiles_org_role_chk check (org_role is null or org_role in ('owner', 'admin', 'member', 'viewer'));
alter table invites add column if not exists org_role text not null default 'member';
alter table invites drop constraint if exists invites_org_role_chk;
alter table invites add constraint invites_org_role_chk check (org_role in ('admin', 'member', 'viewer'));
-- whether members (not only owners and admins) may approve individual items; the owner decides
alter table agencies add column if not exists members_can_approve boolean not null default false;

-- existing organizations keep today's behaviour: the oldest member is the owner, everyone else an admin
with ranked as (
  select id, row_number() over (partition by agency_id order by created_at, id) as n from profiles where agency_id is not null and org_role is null
)
update profiles p set org_role = case when r.n = 1 and not exists (select 1 from profiles o where o.agency_id = p.agency_id and o.org_role = 'owner') then 'owner' else 'admin' end
from ranked r where r.id = p.id;

-- a person joining an organization: the first one is its owner; later ones get the invite's role (default member)
create or replace function profiles_org_role() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_invite text;
begin
  if new.agency_id is null then new.org_role := null; return new; end if;
  if tg_op = 'UPDATE' and old.agency_id is not distinct from new.agency_id then return new; end if;
  if tg_op = 'UPDATE' and new.org_role is distinct from old.org_role then return new; end if;
  if tg_op = 'INSERT' and new.org_role is not null then return new; end if;
  select i.org_role into v_invite from invites i where i.agency_id = new.agency_id and lower(i.email) = lower(new.email) and i.status <> 'revoked'
    order by i.invited_at desc limit 1;
  if not exists (select 1 from profiles o where o.agency_id = new.agency_id and o.org_role = 'owner' and o.id <> new.id) then
    new.org_role := 'owner';
  else
    new.org_role := coalesce(v_invite, 'member');
  end if;
  return new;
end $$;
drop trigger if exists profiles_org_role on profiles;
create trigger profiles_org_role before insert or update of agency_id on profiles for each row execute function profiles_org_role();

-- ---------------------------------------------------------------- 5. deletion and retention
alter table agencies add column if not exists deleted_at timestamptz;
-- per-organization retention overrides in days: { emailBodies, inboundRaw, jobs }
alter table agencies add column if not exists retention jsonb not null default '{}'::jsonb;
alter table email_messages add column if not exists body_purged_at timestamptz;
alter table email_inbound add column if not exists body_purged_at timestamptz;

create table if not exists org_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  requested_by text not null check (length(requested_by) <= 160),
  requested_at timestamptz not null default now(),
  -- the cooling-off period ends here; nothing is deleted before it
  execute_after timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'executing', 'completed', 'failed')),
  cancelled_by text check (length(cancelled_by) <= 160),
  cancelled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  attempts int not null default 0,
  result jsonb not null default '{}'::jsonb,
  error text check (length(error) <= 500)
);
create unique index if not exists org_deletion_one_open on org_deletion_requests (org_id) where status in ('pending', 'executing');
create index if not exists org_deletion_due on org_deletion_requests (execute_after) where status in ('pending', 'executing');

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['ai_usage', 'ai_budget_overrides', 'workflow_costs', 'org_deletion_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['plans', 'plan_changes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_staff_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff())', t || '_staff_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
grant usage on sequence ai_usage_id_seq, plan_changes_id_seq to service_role;

drop trigger if exists audit_org_deletion_requests on org_deletion_requests;
create trigger audit_org_deletion_requests after insert or update or delete on org_deletion_requests for each row execute function audit_row();
-- plans are audited in plan_changes (and engine_audit) by the staff editing API
