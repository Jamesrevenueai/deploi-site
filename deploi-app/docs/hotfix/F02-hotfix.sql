-- F-02 HOTFIX for the Supabase SQL editor (deploi-prod). One transaction: either everything applies or nothing does.
-- Generated from supabase/migrations/20261031000001_signup_trust_hotfix.sql; records it in _migrations so later migration runs skip it.
begin;
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := 'client';
  v_agency uuid := null;
  -- raw_app_meta_data is writable only with the service role key; raw_user_meta_data is not trusted
  v_meta jsonb := coalesce(to_jsonb(new) -> 'raw_app_meta_data', '{}'::jsonb);
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
  if lower(new.email) = any (select btrim(x) from unnest(string_to_array(staff_email_list(), ',')) as x where btrim(x) <> '') then
    v_role := 'staff';
  end if;
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  update invites set accepted_at = now(), status = 'accepted', supabase_user_id = new.id
    where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked';
  return new;
end $$;

alter view if exists leads set (security_invoker = true);
do $$ begin
  if to_regclass('public.leads') is not null then execute 'revoke all on leads from anon, authenticated'; end if;
end $$;

revoke execute on function staff_email_list() from public, anon, authenticated;
insert into _migrations (name) values ('20261031000001_signup_trust_hotfix.sql') on conflict (name) do nothing;
commit;
