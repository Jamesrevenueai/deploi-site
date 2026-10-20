-- Item 4: client invites. Staff invites an email for an agency; Supabase sends the
-- magic link; the auth trigger (or the app's bootstrap) creates the profile with
-- the invited agency and role on first sign-in.
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  email text not null,
  role user_role not null default 'client',
  invited_by uuid,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  supabase_user_id uuid,
  status text not null default 'sent', -- sent | pending (no auth provider) | accepted | revoked
  created_at timestamptz not null default now()
);
create unique index if not exists invites_agency_email_uq on invites (agency_id, lower(email));

alter table invites enable row level security;
drop policy if exists invites_staff_all on invites;
create policy invites_staff_all on invites for all to authenticated using (is_staff()) with check (is_staff());
grant all on invites to authenticated, service_role;

drop trigger if exists audit_invites on invites;
create trigger audit_invites after insert or update or delete on invites for each row execute function audit_row();

-- Off-Supabase the auth shim predates this column; on Supabase it already exists (no-op).
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data') then
    alter table auth.users add column raw_user_meta_data jsonb default '{}'::jsonb;
  end if;
end $$;

-- Profiles for new auth users: staff emails win; otherwise an invite's agency/role
-- (carried in raw_user_meta_data by inviteUserByEmail, or matched by email).
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := 'client';
  v_agency uuid := null;
  v_meta jsonb := coalesce(to_jsonb(new) -> 'raw_user_meta_data', '{}'::jsonb);
  v_invite invites%rowtype;
begin
  if nullif(v_meta ->> 'agency_id', '') is not null then
    begin v_agency := (v_meta ->> 'agency_id')::uuid; exception when others then v_agency := null; end;
  end if;
  if (v_meta ->> 'role') in ('staff', 'client') then
    v_role := (v_meta ->> 'role')::user_role;
  end if;
  if v_agency is null then
    select * into v_invite from invites where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked'
      order by invited_at desc limit 1;
    if found then v_agency := v_invite.agency_id; v_role := v_invite.role; end if;
  end if;
  if position(lower(new.email) in lower(coalesce(current_setting('app.staff_emails', true), ''))) > 0 then
    v_role := 'staff';
  end if;
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  update invites set accepted_at = now(), status = 'accepted', supabase_user_id = new.id
    where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked';
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
