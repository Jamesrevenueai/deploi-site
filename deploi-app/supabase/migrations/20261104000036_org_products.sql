-- =============================================================================
-- Products an organization uses: Deploi Commerce (Shopify or WooCommerce stores) and Deploi Office
-- (CRM, calendar, lead follow-up). One row per enabled product. Onboarding writes it; the app reads it
-- to decide which areas and agent templates to offer. Same RLS model as the engine: members read their
-- own organization's rows, staff read all, every write goes through server-side functions.
-- Rollback: supabase/rollback/20261104000036_org_products.down.sql
-- =============================================================================
create table if not exists org_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  product text not null check (product in ('commerce', 'office')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  enabled_by text not null,
  enabled_at timestamptz not null default now(),
  disabled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, product)
);
alter table org_products enable row level security;
drop policy if exists org_products_org_read on org_products;
create policy org_products_org_read on org_products for select to authenticated using (is_staff() or org_id = current_org_id());
grant select on org_products to authenticated;
grant all on org_products to service_role;
drop trigger if exists audit_org_products on org_products;
create trigger audit_org_products after insert or update or delete on org_products for each row execute function audit_row();
drop trigger if exists touch_updated_org_products on org_products;
create trigger touch_updated_org_products before update on org_products for each row execute function set_updated_at();

-- every existing merchant organization already uses Commerce
insert into org_products (org_id, product, enabled_by)
select id, 'commerce', 'migration:20261104000036' from agencies where org_type = 'merchant'
on conflict (org_id, product) do nothing;
