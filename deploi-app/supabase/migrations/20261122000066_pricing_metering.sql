-- 066: pricing v2 and action metering (2026-11-22).
--   plans               Store Starter/Growth/Pro at $79/$199/$499 (Shopify billing); Office Solo/Team/Business at
--                       $149/$349/$799 (Stripe). The earlier hypothesis bundles are retired (kept for history).
--   actions             the metering ledger: one row per completed step that changed something outside Deploi
--                       (billable) or a free step recorded for the proof trail (billable = false)
--   org_usage_caps      the customer-set overage cap per month (cents) for actions and texts
--   usage_cap_events    one row per organization and month when the cap was reached (owner told once)
-- Additive except the plan rows' prices and limits (the old values are in plan_changes).
-- Rollback: supabase/rollback/20261122000066_pricing_metering.down.sql.

insert into plan_changes (plan_key, version, actor, change)
select key, version, 'migration 066 (pricing v2)', jsonb_build_object('before', to_jsonb(p.*) - 'updated_at')
from plans p where key in ('starter','growth','pro','office_starter','commerce_operations','business_workforce');

update plans set display_name = 'Starter', monthly_price_cents = 7900, trial_days = 14, status = 'approved', approved_by = 'founder brief 2026-11-22', approved_at = now(),
  limits = '{"maxAgents":12,"monthlyActions":1500,"monthlyEmails":1500,"customAgents":1,"stores":1,"officeSeats":2,"officeConnections":2,"maxCompetitorStores":5,"aiBudgetUsd":10}'::jsonb,
  version = version + 1, updated_by = 'migration 066', updated_at = now() where key = 'starter';
update plans set display_name = 'Growth', monthly_price_cents = 19900, trial_days = 14, status = 'approved', approved_by = 'founder brief 2026-11-22', approved_at = now(),
  limits = '{"maxAgents":20,"monthlyActions":5000,"monthlyEmails":5000,"customAgents":5,"stores":1,"officeSeats":5,"officeConnections":5,"maxCompetitorStores":15,"aiBudgetUsd":25}'::jsonb,
  version = version + 1, updated_by = 'migration 066', updated_at = now() where key = 'growth';
update plans set display_name = 'Pro', monthly_price_cents = 49900, trial_days = 14, status = 'approved', approved_by = 'founder brief 2026-11-22', approved_at = now(),
  limits = '{"maxAgents":100,"monthlyActions":15000,"monthlyEmails":15000,"customAgents":1000,"stores":100,"officeSeats":15,"officeConnections":15,"maxCompetitorStores":50,"aiBudgetUsd":60}'::jsonb,
  version = version + 1, updated_by = 'migration 066', updated_at = now() where key = 'pro';
update plans set active = false, status = 'retired', version = version + 1, updated_by = 'migration 066', updated_at = now()
  where key in ('office_starter', 'commerce_operations', 'business_workforce');

insert into plans (key, suite, display_name, monthly_price_cents, tier_key, limits, trial_days, status, approved_by, approved_at, updated_by) values
  ('solo', 'office', 'Solo', 14900, 'starter', '{"maxAgents":6,"monthlyActions":2000,"monthlyTexts":300,"monthlyEmails":2000,"crew":0,"customAgents":1,"officeSeats":2,"officeConnections":4,"aiBudgetUsd":15}', 14, 'approved', 'founder brief 2026-11-22', now(), 'migration 066'),
  ('team', 'office', 'Team', 34900, 'growth', '{"maxAgents":12,"monthlyActions":6000,"monthlyTexts":1000,"monthlyEmails":6000,"crew":15,"customAgents":5,"officeSeats":8,"officeConnections":8,"aiBudgetUsd":35}', 14, 'approved', 'founder brief 2026-11-22', now(), 'migration 066'),
  ('business', 'office', 'Business', 79900, 'pro', '{"maxAgents":100,"monthlyActions":20000,"monthlyTexts":4000,"monthlyEmails":20000,"crew":10000,"customAgents":1000,"officeSeats":50,"officeConnections":30,"aiBudgetUsd":80}', 14, 'approved', 'founder brief 2026-11-22', now(), 'migration 066')
on conflict (key) do nothing;

create table if not exists actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_key text not null check (length(agent_key) between 1 and 120),
  type text not null check (type ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- what the action used up: an agent action, or a text message (Office plans have a separate text allowance)
  kind text not null default 'action' check (kind in ('action', 'text')),
  billable boolean not null,
  -- where the proof lives: a case ref (DC-000123), a loop id, a notify_outbox id, a library action id ...
  proof_ref text check (length(proof_ref) <= 200),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index if not exists actions_org_month on actions (org_id, created_at) where billable;

create table if not exists org_usage_caps (
  org_id uuid primary key references agencies(id) on delete cascade,
  -- the most overage the customer allows per month, in cents (0 = stop at the plan's allowance)
  action_overage_cap_cents int not null default 0 check (action_overage_cap_cents between 0 and 10000000),
  text_overage_cap_cents int not null default 0 check (text_overage_cap_cents between 0 and 10000000),
  updated_by text check (length(updated_by) <= 160),
  updated_at timestamptz not null default now()
);

create table if not exists usage_cap_events (
  org_id uuid not null references agencies(id) on delete cascade,
  month date not null,
  kind text not null check (kind in ('action', 'text')),
  reached_at timestamptz not null default now(),
  primary key (org_id, month, kind)
);

do $$ declare t text; begin
  foreach t in array array['actions', 'org_usage_caps', 'usage_cap_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
