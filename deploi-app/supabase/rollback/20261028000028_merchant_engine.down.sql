-- Rollback of 20261028000028_merchant_engine.sql
select pg_temp.assert_empty('store_connections');
select pg_temp.assert_empty('engine_audit');
do $$ begin
  if exists (select 1 from agencies where org_type = 'merchant') and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: merchant organizations exist; set deploi.rollback_discard_data = ''on'' to discard their type';
  end if;
end $$;
drop table if exists synthetic_store_state;
drop table if exists app_subscriptions;
drop table if exists webhook_receipts;
drop table if exists engine_audit;
drop table if exists executions;
drop table if exists approvals;
drop table if exists proposals;
drop table if exists issues;
drop table if exists scans;
drop table if exists merchant_rules;
drop function if exists bump_rule_version();
drop table if exists store_credentials;
drop table if exists store_connections;
drop function if exists current_org_id();
alter table agencies drop constraint if exists agencies_org_type_chk;
alter table agencies drop column if exists org_type;
-- audit_row() as defined in 20261020000001_foundation.sql (agency_id only)
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
  v_agency uuid;
begin
  if tg_op = 'DELETE' then
    v_row_id := old.id::text;
  else
    v_row_id := new.id::text;
  end if;
  begin
    if tg_op = 'DELETE' then
      v_agency := (to_jsonb(old) ->> 'agency_id')::uuid;
    else
      v_agency := (to_jsonb(new) ->> 'agency_id')::uuid;
    end if;
  exception when others then v_agency := null; end;
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  values (auth.uid(), v_agency, tg_table_name, v_row_id, lower(tg_op),
          nullif(current_setting('app.ip', true), ''));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
