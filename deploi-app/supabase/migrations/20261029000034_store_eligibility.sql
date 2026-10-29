-- =============================================================================
-- Install and write eligibility for real Shopify stores, replacing the env-only LIVE_WRITE_STORES list.
-- Any shop may install (Shopify review and App Store listing require it) and every read-only feature
-- works. WRITES to a real store need an eligibility row granted by Deploi staff:
--   beta      an approved early-access merchant (live writes, optional end date)
--   review    a Shopify app-review or partner development store (live writes, must end)
--   internal  Deploi's own development stores
--   blocked   refused: installation is rejected and nothing is written
-- Synthetic stores never need a row. LIVE_WRITE_STORES and LIVE_WRITES=all still work for local use.
-- =============================================================================
create table if not exists store_eligibility (
  shop text primary key check (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  tier text not null check (tier in ('beta', 'review', 'internal', 'blocked')),
  live_writes boolean not null default false,
  note text,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint store_eligibility_review_ends check (tier <> 'review' or expires_at is not null),
  constraint store_eligibility_blocked_no_writes check (tier <> 'blocked' or live_writes = false)
);
alter table store_eligibility enable row level security;
drop policy if exists store_eligibility_staff on store_eligibility;
create policy store_eligibility_staff on store_eligibility for select to authenticated using (is_staff());
revoke all on store_eligibility from anon, authenticated;
grant select on store_eligibility to authenticated;
grant all on store_eligibility to service_role;
drop trigger if exists audit_store_eligibility on store_eligibility;
create trigger audit_store_eligibility after insert or update or delete on store_eligibility for each row execute function audit_row();
