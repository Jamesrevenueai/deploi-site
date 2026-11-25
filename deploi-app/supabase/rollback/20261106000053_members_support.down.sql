-- Rollback of 20261106000053_members_support.sql. Support conversations, sent system mail and contact
-- messages are refused while they hold rows unless deploi.rollback_discard_data = 'on'. Invites keep their
-- rows; only the signed-link columns are dropped (open links stop working). The sign-up trigger returns to
-- the 20261104000042 version (an invite for the address joins its organization at first sign-in).
select pg_temp.assert_empty('support_messages');
select pg_temp.assert_empty('support_tickets');
select pg_temp.assert_empty('system_emails');
select pg_temp.assert_empty('contact_messages');
drop table if exists support_messages;
drop table if exists support_tickets;
drop table if exists system_emails;
drop table if exists contact_messages;
drop index if exists invites_open;
alter table invites drop column if exists accepted_by;
alter table invites drop column if exists last_sent_at;
alter table invites drop column if exists sent_count;
alter table invites drop column if exists revoked_at;
alter table invites drop column if exists expires_at;
alter table invites drop column if exists token_hash;

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
