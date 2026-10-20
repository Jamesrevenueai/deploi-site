-- Item 5: Business Associate Agreement gate. No client-side data enters the app
-- for an agency until baa_signed_at is set (lib/baa/gate.ts).
alter table agencies
  add column if not exists baa_signed_at timestamptz,
  add column if not exists baa_document_url text;
