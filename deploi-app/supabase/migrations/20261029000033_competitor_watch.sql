-- =============================================================================
-- Competitor & Trend Watcher: watched public stores, each check, the products seen, change-only
-- observations (price and availability history), detected changes and the insights built from them.
-- Same model as the rest of the agent platform: organization members read their own rows; every write
-- goes through server-side code (service role) after an explicit authorization check.
-- Nothing here holds a competitor's private data: only what their public pages showed, with timestamps.
-- =============================================================================

create table if not exists competitor_stores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  origin text not null check (origin ~ '^https://[a-z0-9.-]+$'),
  domain text not null,
  label text not null check (length(trim(label)) between 1 and 80),
  bestseller_handle text,
  source_key text not null default 'shopify_public',
  -- pending: never checked; supported: last check succeeded; the rest explain why it could not be read
  status text not null default 'pending' check (status in ('pending', 'supported', 'unsupported', 'blocked', 'rate_limited', 'error', 'removed')),
  status_reason text,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  store_name text,
  baseline_at timestamptz,
  last_check_complete boolean not null default false,
  bestseller_observed boolean not null default false,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures int not null default 0,
  failing_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, domain)
);
create index if not exists competitor_stores_org_idx on competitor_stores (org_id, agent_id);

create table if not exists competitor_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  store_id uuid not null references competitor_stores(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete set null,
  -- complete: every page read; partial: some pages read (nothing inferred about missing products); failed; skipped (budget)
  outcome text not null check (outcome in ('complete', 'partial', 'failed', 'skipped')),
  status text not null,
  reason text,
  product_count int not null default 0,
  requests_used int not null default 0,
  bestseller_status text,
  currency text,
  source_urls text[] not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists competitor_checks_store_idx on competitor_checks (store_id, started_at desc);

create table if not exists competitor_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  store_id uuid not null references competitor_stores(id) on delete cascade,
  external_id text not null,
  handle text not null,
  title text not null,
  url text not null,
  product_type text not null default '',
  vendor text not null default '',
  tags text[] not null default '{}',
  published_at timestamptz,
  first_seen_at timestamptz not null,
  in_baseline boolean not null default false,
  listed boolean not null default true,
  missing_streak int not null default 0,
  last_seen_at timestamptz not null,
  currency text,
  variants jsonb not null default '[]'::jsonb,
  price_min numeric(14,2),
  price_max numeric(14,2),
  on_sale boolean not null default false,
  available_count int not null default 0,
  availability_known int not null default 0,
  bestseller_rank int,
  unique (store_id, external_id)
);
create index if not exists competitor_products_store_idx on competitor_products (store_id, listed);

-- change-only history: a new row when anything observed changed; otherwise last_confirmed_at moves forward
create table if not exists competitor_observations (
  id bigserial primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  store_id uuid not null references competitor_stores(id) on delete cascade,
  product_id uuid not null references competitor_products(id) on delete cascade,
  check_id uuid references competitor_checks(id) on delete set null,
  observed_at timestamptz not null,
  last_confirmed_at timestamptz not null,
  currency text,
  price_min numeric(14,2),
  price_max numeric(14,2),
  on_sale boolean not null default false,
  available_count int not null default 0,
  availability_known int not null default 0,
  variant_count int not null default 0,
  bestseller_rank int,
  variants jsonb not null default '[]'::jsonb
);
create index if not exists competitor_observations_product_idx on competitor_observations (product_id, observed_at desc);

create table if not exists competitor_changes (
  id bigserial primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  store_id uuid not null references competitor_stores(id) on delete cascade,
  check_id uuid references competitor_checks(id) on delete set null,
  kind text not null,
  external_id text,
  title text,
  url text,
  observed_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists competitor_changes_agent_idx on competitor_changes (agent_id, kind, observed_at desc);

create table if not exists competitor_insights (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete set null,
  kind text not null,
  dedupe_key text not null,
  headline text not null,
  basis text not null check (basis in ('observed', 'inferred', 'unavailable')),
  facts jsonb not null default '[]'::jsonb,
  stores jsonb not null default '[]'::jsonb,
  products jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  period_start timestamptz not null,
  period_end timestamptz not null,
  inference text,
  limitations jsonb not null default '[]'::jsonb,
  next_action text not null,
  meaningful boolean not null default false,
  status text not null default 'new' check (status in ('new', 'dismissed', 'handed_off')),
  handoff jsonb,
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, dedupe_key)
);
create index if not exists competitor_insights_agent_idx on competitor_insights (agent_id, created_at desc);

-- two new email task keys: competitor alerts (to the merchant) and sourcing requests handed to a Supplier Chaser
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'competitor_alert', 'sourcing_request'));

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['competitor_stores','competitor_checks','competitor_products','competitor_observations','competitor_changes','competitor_insights'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  grant usage on sequence competitor_observations_id_seq to service_role;
  grant usage on sequence competitor_changes_id_seq to service_role;
  foreach t in array array['competitor_stores'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
  foreach t in array array['competitor_stores','competitor_insights'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
end $$;
