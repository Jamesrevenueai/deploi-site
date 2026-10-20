-- Restores the item-4 handle_new_user logic (metadata, invite fallback, revoked/accepted status)
-- with the staff list read from staff_email_list() (GUC or settings table).
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
  if position(lower(new.email) in staff_email_list()) > 0 then
    v_role := 'staff';
  end if;
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  update invites set accepted_at = now(), status = 'accepted', supabase_user_id = new.id
    where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked';
  return new;
end $$;
