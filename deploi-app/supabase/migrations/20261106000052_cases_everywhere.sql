-- =============================================================================
-- Cases everywhere and Shopify customer privacy (F-07).
--  * privacy_exports: the export Deploi builds for a Shopify `customers/data_request`: everything it holds for
--    that customer in that shop's organization, as JSON, encrypted at rest (AES-256-GCM, the credentials key,
--    bound to the row id). The merchant downloads it from the app and answers the customer; Deploi sends
--    nothing to anyone. Members read the row's facts (never the ciphertext); writes are server-side.
--  * case_events stay append-only, with one narrow exception: a `customers/redact` may rewrite an event's
--    summary and detail to erase a customer's address (deploi.privacy_redaction = 'on' in that transaction
--    only); nothing else about an event can change.
-- Case adapters for the store agents, restock requests, competitor signals and library work need no schema.
-- Rollback: supabase/rollback/20261106000052_cases_everywhere.down.sql
-- =============================================================================

create table if not exists privacy_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid references store_connections(id) on delete set null,
  request_id uuid references shopify_compliance_requests(id) on delete set null,
  shop text not null check (length(shop) between 3 and 255),
  -- the customer as a one-way hash (shopify_compliance_requests.subject_hash): never the address
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  -- what the export holds, counted per table (no content)
  summary jsonb not null default '{}'::jsonb,
  size_bytes int not null default 0 check (size_bytes >= 0),
  key_id text not null,
  content_ciphertext text not null,
  created_at timestamptz not null default now(),
  -- the merchant has 30 days to answer Shopify's request; the export is kept a little longer, then purged
  expires_at timestamptz not null default (now() + interval '60 days'),
  downloaded_at timestamptz,
  downloaded_by text check (length(downloaded_by) <= 160),
  download_count int not null default 0
);
create index if not exists privacy_exports_org on privacy_exports (org_id, created_at desc);

alter table privacy_exports enable row level security;
drop policy if exists privacy_exports_org_read on privacy_exports;
create policy privacy_exports_org_read on privacy_exports for select to authenticated using (is_staff() or org_id = current_org_id());
revoke all on privacy_exports from anon, authenticated;
-- the facts only: the encrypted content is read by the server for an owner or admin
grant select (id, org_id, connection_id, request_id, shop, subject_hash, summary, size_bytes, created_at, expires_at, downloaded_at, downloaded_by, download_count) on privacy_exports to authenticated;
grant all on privacy_exports to service_role;
drop trigger if exists audit_privacy_exports on privacy_exports;
create trigger audit_privacy_exports after insert or update or delete on privacy_exports for each row execute function audit_row();

-- case events: append-only, except an address erased by a customer redaction (summary and detail only)
create or replace function case_events_append_only() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('deploi.privacy_redaction', true), '') = 'on'
     and (old.id, old.case_id, old.org_id, old.at, old.actor, old.type, old.from_status, old.to_status, old.ref_type, old.ref_id)
         is not distinct from (new.id, new.case_id, new.org_id, new.at, new.actor, new.type, new.from_status, new.to_status, new.ref_type, new.ref_id) then
    return new;
  end if;
  raise exception 'case_events are append-only';
end $$;
