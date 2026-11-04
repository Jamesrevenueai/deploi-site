-- Rollback of 20261104000036_org_products.sql. Commerce rows are derived from agencies.org_type and are
-- recreated by re-applying the migration; an enabled Deploi Office is a customer's choice and would be lost,
-- so it is refused unless deploi.rollback_discard_data = 'on'.
do $$ begin
  if to_regclass('public.org_products') is not null and exists (select 1 from org_products where product = 'office')
     and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: org_products has organizations with Deploi Office enabled; set deploi.rollback_discard_data = ''on'' to discard them';
  end if;
end $$;
drop table if exists org_products;
