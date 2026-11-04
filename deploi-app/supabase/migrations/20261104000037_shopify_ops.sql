-- =============================================================================
-- Shopify operations: reconnect state for expiring offline tokens, debounced webhook rescans,
-- privacy (compliance) requests, supplier mappings and supplier restock requests.
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every
-- write goes through server-side functions (service role).
-- Rollback: supabase/rollback/20261104000037_shopify_ops.down.sql
-- =============================================================================

-- A connection whose refresh token Shopify refused (or that expired) needs the merchant to reopen the app.
-- status = 'error' stops scans and agents; the reason says what to do. Token exchange on the next app open clears it.
alter table store_connections add column if not exists status_reason text;
alter table store_connections add column if not exists reauth_required_at timestamptz;

-- Webhook-driven rescans are debounced: bursts of inventory_levels/update and products/update for the same
-- record collapse into one targeted read. Rows are deleted when the rescan claims them.
create table if not exists shopify_rescan_queue (
  connection_id uuid not null references store_connections(id) on delete cascade,
  resource_id text not null,
  first_seen_at timestamptz not null default now(),
  due_at timestamptz not null,
  hits int not null default 1,
  topics text[] not null default '{}',
  primary key (connection_id, resource_id)
);
create index if not exists shopify_rescan_queue_due on shopify_rescan_queue (due_at);

-- Mandatory privacy webhooks, one row per delivery. Holds no customer contact details: the customer is
-- recorded as a one-way hash so a request can be matched without keeping the address.
create table if not exists shopify_compliance_requests (
  id uuid primary key default gen_random_uuid(),
  shop text not null,
  connection_id uuid references store_connections(id) on delete set null,
  org_id uuid references agencies(id) on delete set null,
  topic text not null check (topic in ('customers/data_request', 'customers/redact', 'shop/redact')),
  webhook_id text not null unique,
  subject_hash text,
  status text not null default 'received' check (status in ('received', 'completed', 'deferred', 'failed')),
  result jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists shopify_compliance_requests_shop on shopify_compliance_requests (shop, received_at desc);

-- Supplier mapping is a reference file kind: sku -> supplier email, reorder quantity, lead time.
alter table reference_sources drop constraint if exists reference_sources_kind_check;
alter table reference_sources add constraint reference_sources_kind_check check (kind in ('price_list', 'sku_mapping', 'publication_list', 'supplier_mapping'));

-- One consolidated restock request per agent, supplier and day. Mirrors the email message it was sent as,
-- its single follow-up and the supplier's reply. An ETA found in a reply is stored as data, never acted on.
create table if not exists supplier_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  supplier_address text not null,
  request_day date not null,
  message_id uuid unique references email_messages(id) on delete set null,
  followup_message_id uuid references email_messages(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  status text not null default 'drafted' check (status in ('drafted', 'awaiting_approval', 'sending', 'sent', 'followed_up', 'replied', 'not_sent', 'unknown')),
  status_reason text,
  sent_at timestamptz,
  followed_up_at timestamptz,
  replied_at timestamptz,
  reply_count int not null default 0,
  eta_date date,
  eta_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, supplier_address, request_day)
);
create index if not exists supplier_requests_agent on supplier_requests (agent_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['supplier_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
  -- operational tables: staff read only
  foreach t in array array['shopify_rescan_queue', 'shopify_compliance_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_staff', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff())', t || '_staff', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
