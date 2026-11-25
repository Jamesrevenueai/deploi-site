-- =============================================================================
-- Account lifecycle: member invitations with signed links, platform (system) email, sign-up without
-- implicit organization assignment, customer support tickets and the public contact form.
--
--  1. invites: a signed, expiring, single-use link. Only a digest of the link's nonce is stored; resending
--     rotates it (the old link stops working), revoking closes it. The invite is consumed only by server
--     code (lib/platform/invites.ts acceptInvite) after the signed-in address matches the invited one.
--  2. handle_new_user: a new sign-in no longer joins an organization because an invite exists for its
--     address. Only server-set app metadata assigns an organization at sign-up (F-02 trust model kept);
--     invites are accepted through their link. Everything else is unchanged.
--  3. system_emails: every platform message (invitations, support notices, later operations alerts) with
--     its idempotency key and outcome. No agent, no organization mailbox. Staff read only.
--  4. support_tickets / support_messages: the customer's "Get help" requests and the conversation with
--     Deploi staff. Organization-scoped (RLS): a customer reads only its own organization's tickets.
--  5. contact_messages: the public website contact form. Staff read only.
-- Rollback: supabase/rollback/20261106000053_members_support.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. invites
alter table invites add column if not exists token_hash text;
alter table invites add column if not exists expires_at timestamptz;
alter table invites add column if not exists revoked_at timestamptz;
alter table invites add column if not exists sent_count int not null default 0;
alter table invites add column if not exists last_sent_at timestamptz;
alter table invites add column if not exists accepted_by uuid;
create index if not exists invites_open on invites (agency_id) where accepted_at is null and status <> 'revoked';

-- ---------------------------------------------------------------- 2. sign-up
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := 'client';
  v_agency uuid := null;
  -- raw_app_meta_data is writable only with the service role key; raw_user_meta_data is never read
  v_meta jsonb := coalesce(to_jsonb(new) -> 'raw_app_meta_data', '{}'::jsonb);
begin
  if nullif(v_meta ->> 'agency_id', '') is not null then
    begin v_agency := (v_meta ->> 'agency_id')::uuid; exception when others then v_agency := null; end;
  end if;
  if (v_meta ->> 'role') in ('staff', 'client') then
    v_role := (v_meta ->> 'role')::user_role;
  end if;
  if lower(new.email) = any (select btrim(x) from unnest(string_to_array(staff_email_list(), ',')) as x where btrim(x) <> '') then
    v_role := 'staff';
  end if;
  -- an invite is NOT applied here: it is accepted through its signed link (lib/platform/invites.ts)
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------------------------------------------------------------- 3. system email
create table if not exists system_emails (
  id uuid primary key default gen_random_uuid(),
  -- one message per key: a retry of the same logical message never sends twice
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  template text not null check (length(template) <= 80),
  -- the organization the message concerns, when there is one (never a sender)
  org_id uuid references agencies(id) on delete set null,
  to_address text not null check (length(to_address) <= 320),
  from_address text not null check (length(from_address) <= 320),
  subject text not null check (length(subject) <= 300),
  -- the bodies as sent, with single-use links replaced by "[link removed]"
  body_text text not null,
  body_html text not null,
  status text not null default 'pending' check (status in ('pending', 'held', 'sent', 'failed', 'uncertain')),
  status_reason text check (length(status_reason) <= 500),
  provider_message_id text,
  attempts int not null default 0,
  related jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists system_emails_created on system_emails (created_at desc);

-- ---------------------------------------------------------------- 4. support
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  ref text not null unique,
  created_by uuid,
  created_by_email text not null check (length(created_by_email) <= 320),
  category text not null check (category in ('question', 'problem', 'billing', 'account', 'agent', 'other')),
  subject text not null check (length(subject) between 1 and 200),
  case_ref text check (case_ref is null or length(case_ref) <= 40),
  page text check (page is null or length(page) <= 300),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_staff_reply_at timestamptz
);
create index if not exists support_tickets_org on support_tickets (org_id, created_at desc);
create index if not exists support_tickets_open on support_tickets (status, created_at) where status not in ('resolved', 'closed');

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  author_kind text not null check (author_kind in ('customer', 'staff')),
  author_email text not null check (length(author_email) <= 320),
  body text not null check (length(body) between 1 and 8000),
  system_email_id uuid references system_emails(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket on support_messages (ticket_id, created_at);

-- ---------------------------------------------------------------- 5. website contact form
create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  email text not null check (length(email) <= 320),
  company text check (company is null or length(company) <= 200),
  topic text not null check (topic in ('sales', 'support', 'partnership', 'press', 'other')),
  message text not null check (length(message) between 1 and 4000),
  ip inet,
  status text not null default 'new' check (status in ('new', 'answered', 'spam')),
  created_at timestamptz not null default now()
);
create index if not exists contact_messages_created on contact_messages (created_at desc);

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['support_tickets', 'support_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['system_emails', 'contact_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_staff_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff())', t || '_staff_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

drop trigger if exists audit_support_tickets on support_tickets;
create trigger audit_support_tickets after insert or update or delete on support_tickets for each row execute function audit_row();
