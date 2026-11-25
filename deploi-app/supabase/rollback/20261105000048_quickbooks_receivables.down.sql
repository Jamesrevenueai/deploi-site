-- Rollback of 20261105000048_quickbooks_receivables.sql (run after _guard.sql, inside one transaction).
-- Removes the Accounts Receivable agent's invoice tracking and the QuickBooks provider. Refuses while invoices,
-- AR agents or QuickBooks connections exist unless deploi.rollback_discard_data = 'on' (then they are deleted;
-- their cases stay, as the customer's work history).
select pg_temp.assert_empty('office_invoices');
create or replace function pg_temp.assert_none(t text, w text) returns void language plpgsql as $$
declare n bigint;
begin
  if to_regclass(t) is null then return; end if;
  execute format('select count(*) from %s where %s', t, w) into n;
  if n > 0 and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: % has % row(s) where %; set deploi.rollback_discard_data = ''on'' to discard them', t, n, w;
  end if;
end $$;
select pg_temp.assert_none('office_agents', $w$kind = 'accounts_receivable'$w$);
select pg_temp.assert_none('office_connections', $w$provider = 'quickbooks'$w$);
drop table if exists office_invoices;
update office_agents set active_policy_id = null where kind = 'accounts_receivable';
delete from office_agents where kind = 'accounts_receivable';
delete from office_connections where provider = 'quickbooks';
delete from office_oauth_states where provider = 'quickbooks';
drop index if exists office_connections_quickbooks_realm;
-- shrink the value lists again (other values, added by other migrations, are kept)
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
select pg_temp.shrink_in_check('office_connections', 'office_connections_provider_check', 'provider', 'quickbooks');
select pg_temp.shrink_in_check('office_oauth_states', 'office_oauth_states_provider_check', 'provider', 'quickbooks');
select pg_temp.shrink_in_check('office_agents', 'office_agents_kind_check', 'kind', 'accounts_receivable');
