-- =============================================================================
-- Store access (eligibility) for the public Shopify app. Replaces the development-only
-- LIVE_WRITE_STORES environment allowlist. Any shop can install; whether Deploi may write to the
-- store or send real email for it depends on its access record:
--   * STORE_ACCESS_MODE=open  every installed store is eligible (the public listing)
--   * STORE_ACCESS_MODE=beta  eligible only when Shopify reports a development store (partners'
--     test stores), when the merchant redeems a beta invite, or when Deploi staff
--     approve the store. Other stores can scan and review but nothing is written.
-- Every change is audited. Invite codes are stored only as SHA-256 hashes.
-- =============================================================================

create table if not exists beta_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  label text not null,
  -- optional binding: only this shop may redeem it
  shop_domain text,
  max_uses int not null default 1 check (max_uses between 1 and 100),
  uses int not null default 0,
  expires_at timestamptz not null,
  created_by text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists store_access (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'shopify' check (platform in ('shopify', 'woocommerce', 'amazon')),
  external_id text not null,
  org_id uuid references agencies(id) on delete cascade,
  status text not null default 'pending' check (status in ('eligible', 'pending', 'denied')),
  basis text check (basis in ('open_access', 'development_store', 'beta_invite', 'staff_approved')),
  -- facts read from Shopify (shop.plan) at install and re-checked periodically
  is_development_store boolean,
  plan_name text,
  facts_checked_at timestamptz,
  invite_id uuid references beta_invites(id) on delete set null,
  requested_at timestamptz,
  request_note text,
  -- a staff decision overrides the automatic rules ("denied" wins over everything)
  staff_decision text check (staff_decision in ('approved', 'denied')),
  decided_by text,
  decided_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index if not exists store_access_status_idx on store_access (status, requested_at);

-- RLS: org members read their own record; invites are service-role only.
alter table store_access enable row level security;
drop policy if exists store_access_org_read on store_access;
create policy store_access_org_read on store_access for select to authenticated using (is_staff() or org_id = current_org_id());
revoke all on store_access from anon, authenticated;
grant select on store_access to authenticated;
grant all on store_access to service_role;
drop trigger if exists touch_updated_store_access on store_access;
create trigger touch_updated_store_access before update on store_access for each row execute function set_updated_at();

alter table beta_invites enable row level security;
revoke all on beta_invites from anon, authenticated;
grant all on beta_invites to service_role;

-- The shop's global ID (gid://shopify/Shop/<n>): the Partner API needs it to look up the shop's
-- Shopify App Pricing subscription.
alter table store_connections add column if not exists shop_gid text;
