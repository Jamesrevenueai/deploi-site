-- =============================================================================
-- Customer experience: every merchant organization starts with Deploi Commerce, including ones
-- created after 20261104000036 (the Shopify install path, the seed). The setup wizard can switch it
-- off when the owner chooses only Deploi Office. No new table; RLS on org_products is unchanged.
-- Rollback: supabase/rollback/20261104000041_customer_experience.down.sql
-- =============================================================================
create or replace function org_products_default_commerce() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_type = 'merchant' then
    insert into org_products (org_id, product, enabled_by) values (new.id, 'commerce', 'default:new_merchant')
    on conflict (org_id, product) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists org_products_default_commerce on agencies;
create trigger org_products_default_commerce after insert on agencies for each row execute function org_products_default_commerce();

-- merchants created between the two migrations
insert into org_products (org_id, product, enabled_by)
select id, 'commerce', 'migration:20261104000041' from agencies where org_type = 'merchant'
on conflict (org_id, product) do nothing;
