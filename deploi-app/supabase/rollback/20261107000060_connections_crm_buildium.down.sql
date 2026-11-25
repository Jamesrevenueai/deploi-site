-- Rollback of 20261107000060_connections_crm_buildium.sql (run after _guard.sql, inside one transaction).
-- Refuses while change cursors, recorded events or connections of the new providers exist, unless
-- deploi.rollback_discard_data = 'on' (then they are deleted; their encrypted credentials go with them).
select pg_temp.assert_empty('connection_events');
select pg_temp.assert_empty('connection_sync_cursors');
create or replace function pg_temp.assert_none(t text, w text) returns void language plpgsql as $$
declare n bigint;
begin
  if to_regclass(t) is null then return; end if;
  execute format('select count(*) from %s where %s', t, w) into n;
  if n > 0 and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: % has % row(s) where %; set deploi.rollback_discard_data = ''on'' to discard them', t, n, w;
  end if;
end $$;
select pg_temp.assert_none('office_connections', $w$provider in ('salesforce', 'pipedrive', 'zoho_crm', 'buildium')$w$);
drop table if exists connection_events;
drop table if exists connection_sync_cursors;
delete from office_credentials where connection_id in (select id from office_connections where provider in ('salesforce', 'pipedrive', 'zoho_crm', 'buildium'));
delete from office_connections where provider in ('salesforce', 'pipedrive', 'zoho_crm', 'buildium');
delete from office_oauth_states where provider in ('salesforce', 'pipedrive', 'zoho_crm');
delete from connection_health where integration in ('salesforce', 'pipedrive', 'zoho_crm', 'buildium');
delete from connection_health_state where integration in ('salesforce', 'pipedrive', 'zoho_crm', 'buildium');
alter table office_connections drop column if exists api_base;
alter table email_oauth_states drop column if exists want_calendar;
create or replace function pg_temp.shrink_in_check(t text, c text, col text, val text) returns void language plpgsql as $$
declare def text; vals text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = t::regclass and conname = c;
  if def is null or position(quote_literal(val) in def) = 0 then return; end if;
  vals := substring(def from 'ARRAY\[(.*)\]');
  vals := regexp_replace(vals, ',?\s*' || quote_literal(val) || '::text', '');
  vals := regexp_replace(vals, '^\s*,\s*', '');
  execute format('alter table %I drop constraint %I', t, c);
  execute format('alter table %I add constraint %I check (%I = any (array[%s]))', t, c, col, vals);
end $$;
do $$ declare p text; begin
  foreach p in array array['salesforce', 'pipedrive', 'zoho_crm', 'buildium'] loop
    perform pg_temp.shrink_in_check('office_connections', 'office_connections_provider_check', 'provider', p);
    perform pg_temp.shrink_in_check('office_oauth_states', 'office_oauth_states_provider_check', 'provider', p);
    perform pg_temp.shrink_in_check('connection_health', 'connection_health_integration_check', 'integration', p);
    perform pg_temp.shrink_in_check('connection_health_state', 'connection_health_state_integration_check', 'integration', p);
  end loop;
end $$;
