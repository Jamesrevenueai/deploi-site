-- Rollback of 20261122000066_pricing_metering.sql (run after _guard.sql, inside one transaction).
-- The metering ledger is refused while it holds rows unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('actions');
drop table if exists usage_cap_events;
drop table if exists org_usage_caps;
drop table if exists actions;
delete from plans where key in ('solo', 'team', 'business') and not exists (select 1 from agencies a where a.plan_key in ('solo','team','business'));
-- restore the plan rows recorded by 066 (prices, limits, status)
update plans p set display_name = c.change->'before'->>'display_name', monthly_price_cents = (c.change->'before'->>'monthly_price_cents')::int,
  limits = c.change->'before'->'limits', trial_days = (c.change->'before'->>'trial_days')::int, status = c.change->'before'->>'status',
  active = (c.change->'before'->>'active')::boolean, approved_by = c.change->'before'->>'approved_by', approved_at = (c.change->'before'->>'approved_at')::timestamptz,
  version = p.version + 1, updated_by = 'rollback 066', updated_at = now()
from plan_changes c where c.plan_key = p.key and c.actor = 'migration 066 (pricing v2)';
