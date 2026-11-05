-- =============================================================================
-- Commerce flagship: supplier exception resolution on purchase orders.
-- Shopify and WooCommerce have no purchase-order API, so purchase orders come only from an authorized import
-- (a CSV the merchant uploads) or a merchant-approved change (a reorder of a remainder). Deploi never invents one.
--  purchase_orders / purchase_order_lines   the PO record: the source of truth a supplier exception is verified against
--  purchase_order_resolutions               resolution options proposed from a supplier's reply; each changes the PO,
--                                           so each needs the owner's approval of its exact change (content hash)
--  supplier_replies                         each supplier reply handled once, parsed deterministically as data
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every write goes
-- through server functions (service role).
-- Rollback: supabase/rollback/20261105000046_purchase_orders.down.sql
-- =============================================================================
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  -- the store the PO's SKUs are matched against (optional: a PO can be imported before a store is connected)
  connection_id uuid references store_connections(id) on delete set null,
  po_number text not null check (length(po_number) between 1 and 64),
  supplier_name text check (length(supplier_name) <= 200),
  -- the only address Deploi ever writes to about this PO (validated in code; also needs the agent's recipient rules)
  supplier_email text not null check (length(supplier_email) between 3 and 254),
  status text not null default 'sent' check (status in ('draft', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled')),
  ordered_at date not null,
  sent_at timestamptz,
  -- the delivery date on the order; replaced only by an approved resolution ("accept new date")
  expected_at date,
  -- the date the supplier committed to (from an import or an approved reply)
  confirmed_expected_at date,
  confirmed_at timestamptz,
  currency text not null default 'USD' check (length(currency) = 3),
  subtotal numeric(14, 4) not null default 0,
  source text not null default 'import' check (source in ('import', 'manual')),
  -- sha256 of the uploaded file, and of this PO's own rows in it (re-import of the same rows is a no-op)
  source_file text check (length(source_file) = 64),
  content_hash text check (length(content_hash) = 64),
  -- a reorder of a remainder points at the PO it came from
  parent_po_id uuid references purchase_orders(id) on delete set null,
  created_by text not null default 'system' check (length(created_by) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, po_number)
);
create index if not exists purchase_orders_org on purchase_orders (org_id, status, updated_at desc);

create table if not exists purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  line_no int not null check (line_no between 1 and 1000),
  sku text not null check (length(sku) between 1 and 120),
  description text check (length(description) <= 300),
  -- the store variant the SKU matched (only when exactly one store record has that SKU)
  variant_ref text check (length(variant_ref) <= 200),
  match_status text not null default 'unmatched' check (match_status in ('matched', 'unmatched', 'ambiguous', 'no_store')),
  qty_ordered int not null check (qty_ordered between 1 and 10000000),
  qty_confirmed int check (qty_confirmed between 0 and 10000000),
  qty_received int not null default 0 check (qty_received between 0 and 10000000),
  unit_price_ordered numeric(14, 4) not null check (unit_price_ordered >= 0),
  -- the price on the order as imported, kept when an approved price change replaces unit_price_ordered
  unit_price_original numeric(14, 4) check (unit_price_original >= 0),
  unit_price_confirmed numeric(14, 4) check (unit_price_confirmed >= 0),
  cancelled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (po_id, line_no),
  unique (po_id, sku)
);
create index if not exists purchase_order_lines_org on purchase_order_lines (org_id, sku);

create table if not exists purchase_order_resolutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  po_id uuid not null references purchase_orders(id) on delete cascade,
  kind text not null check (kind in ('record_confirmation', 'accept_new_date', 'accept_partial_reorder', 'accept_price_change', 'cancel_line')),
  -- what approving does, in plain words, and the exact field changes ({ changes: [{ entity, id, field, from, to }], reorder? })
  summary text not null check (length(summary) <= 1000),
  change jsonb not null default '{}'::jsonb,
  -- an approval is bound to this hash: anything else is refused as stale
  change_hash text not null check (length(change_hash) = 64),
  -- the supplier reply the option was built from (data only)
  reply_id uuid,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'rejected', 'superseded', 'stale', 'withdrawn')),
  status_reason text check (length(status_reason) <= 1000),
  decided_by text check (length(decided_by) <= 160),
  decided_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists purchase_order_resolutions_case on purchase_order_resolutions (case_id, status);
create index if not exists purchase_order_resolutions_org on purchase_order_resolutions (org_id, status, created_at desc);

create table if not exists supplier_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  po_id uuid not null references purchase_orders(id) on delete cascade,
  -- the stored inbound email (lib/email/inbound.ts): each one is handled once
  inbound_id uuid not null unique,
  -- the supplier's own words (quoted history removed), hashed
  content_hash text not null check (length(content_hash) = 64),
  outcome text not null check (outcome in ('clear', 'ambiguous', 'ignored')),
  parsed jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists supplier_replies_org on supplier_replies (org_id, received_at desc);
-- the same words twice (a resent or duplicated message) are handled once: later copies are kept as 'ignored'
create index if not exists supplier_replies_case_content on supplier_replies (case_id, content_hash);

do $$ declare t text; begin
  foreach t in array array['purchase_orders', 'purchase_order_lines', 'purchase_order_resolutions', 'supplier_replies'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
drop trigger if exists audit_purchase_orders on purchase_orders;
create trigger audit_purchase_orders after insert or update or delete on purchase_orders for each row execute function audit_row();
drop trigger if exists audit_purchase_order_lines on purchase_order_lines;
create trigger audit_purchase_order_lines after insert or update or delete on purchase_order_lines for each row execute function audit_row();
drop trigger if exists audit_purchase_order_resolutions on purchase_order_resolutions;
create trigger audit_purchase_order_resolutions after insert or update or delete on purchase_order_resolutions for each row execute function audit_row();
drop trigger if exists touch_updated_purchase_orders on purchase_orders;
create trigger touch_updated_purchase_orders before update on purchase_orders for each row execute function set_updated_at();
drop trigger if exists touch_updated_purchase_order_lines on purchase_order_lines;
create trigger touch_updated_purchase_order_lines before update on purchase_order_lines for each row execute function set_updated_at();
drop trigger if exists touch_updated_purchase_order_resolutions on purchase_order_resolutions;
create trigger touch_updated_purchase_order_resolutions before update on purchase_order_resolutions for each row execute function set_updated_at();

-- the Supplier Coordinator's email task. Other workstreams redefine this same check: keep every task listed
-- (this list = 20261104000043 + 'supplier_exception').
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check
  check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'human_reply', 'office', 'supplier_exception'));
