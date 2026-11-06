-- =============================================================================
-- HOTFIX (SECURITY-REVIEW-2026-11-04 F-02, F-01, F-03): the smallest change that closes self-service
-- staff and cross-organization sign-up, the leads view leak and the public staff e-mail list.
-- Safe to apply on its own to production (migrations through 20261030000035); idempotent; the full
-- release (migration 20261104000042) contains the same statements and re-applies them harmlessly.
--
--  F-02  handle_new_user trusted raw_user_meta_data, which whoever signs up chooses (Supabase signUp /
--        signInWithOtp `data`), and matched staff e-mail by substring. Only server-set app metadata and
--        invites may now assign an organization or role; staff is an exact e-mail match.
--  F-01  the `leads` view ran with its owner's rights, so any signed-in user could read every
--        early-access application. Not used by application code: run it as the caller, close it.
--  F-03  staff_email_list() was callable by anon over RPC. Only the definer trigger needs it.
--
-- It changes no rows. Existing profiles are NOT altered: check them with the query in docs/HOTFIX-F02.md.
-- Rollback: supabase/rollback/20261031000001_signup_trust_hotfix.down.sql (restores the vulnerable
-- function; only for an emergency where sign-up itself breaks).
-- =============================================================================
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
