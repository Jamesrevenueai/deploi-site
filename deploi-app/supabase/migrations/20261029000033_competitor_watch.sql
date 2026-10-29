-- =============================================================================
-- Competitor & Trend Watcher: what other stores show publicly (products, prices, advertised
-- discounts, availability, public best-seller and featured collections), compared over time.
-- Nothing here is the competitor's private data: every row is something anyone could see on the
-- store's public pages at the time recorded, with the URL it came from.
-- Same RLS model as the engine: organization members read their own rows; writes are server-side.
-- Rollback: supabase/rollback/20261029000033_competitor_watch.down.sql
-- =============================================================================

-- One monitored store per agent. The first successful check records the baseline; later checks
-- report changes against it, never "everything is new".
create table if not exists competitor_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  url text not null,
  host text not null,
  -- shopify: the store publishes Shopify's public product feed; unsupported: no source we can read
  platform text not null default 'unknown' check (platform in ('unknown', 'shopify', 'unsupported')),
  -- pending: not checked yet; active: readable; blocked_robots: the store's robots.txt disallows it;
  -- unsupported: no public product feed; unreachable: network or HTTP error
  status text not null default 'pending' check (status in ('pending', 'active', 'blocked_robots', 'unsupported', 'unreachable')),
  status_reason text,
  checks_done int not null default 0,
  baseline_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, host)
);

-- The latest public state of each product seen on a monitored store.
create table if not exists competitor_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  source_id uuid not null references competitor_sources(id) on delete cascade,
  product_key text not null,
  title text not null,
  url text not null,
  product_type text,
  vendor text,
  tags text[] not null default '{}',
  price numeric(14,2),
  compare_at numeric(14,2),
  available boolean,
  published_at timestamptz,
  bestseller_list text,
  bestseller_position int,
  featured_in text[] not null default '{}',
  listed boolean not null default true,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (source_id, product_key)
);
create index if not exists competitor_products_agent_idx on competitor_products (agent_id);

-- Every check of every store: when, what was read, and why a store was skipped.
create table if not exists competitor_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  source_id uuid not null references competitor_sources(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete set null,
  status text not null check (status in ('baseline', 'compared', 'blocked_robots', 'unsupported', 'unreachable')),
  status_reason text,
  requests int not null default 0,
  products_seen int not null default 0,
  urls text[] not null default '{}',
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create index if not exists competitor_checks_agent_idx on competitor_checks (agent_id, started_at desc);

-- Findings. basis = observed: seen on a public page (with URL and time); inference: Deploi's reading
-- of several observations (for example the same kind of product on several stores). Never sales,
-- revenue, units or conversion: those are not public and are never estimated.
create table if not exists competitor_findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  source_id uuid references competitor_sources(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete set null,
  kind text not null check (kind in ('baseline', 'new_product', 'price_drop', 'price_rise', 'discount_started', 'discount_ended',
    'back_in_stock', 'sold_out', 'no_longer_listed', 'bestseller_entered', 'bestseller_moved', 'bestseller_left', 'featured', 'cross_store', 'opportunity')),
  basis text not null check (basis in ('observed', 'inference')),
  title text not null,
  summary text not null,
  product_key text,
  evidence jsonb not null default '[]'::jsonb,
  dedupe_key text not null,
  status text not null default 'new' check (status in ('new', 'seen', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (agent_id, dedupe_key)
);
create index if not exists competitor_findings_agent_idx on competitor_findings (agent_id, created_at desc);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['competitor_sources','competitor_products','competitor_checks','competitor_findings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
