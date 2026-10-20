-- Staff emails can live in the settings table (key 'staff_emails', value: JSON array of emails) because
-- "alter database ... set app.staff_emails" is not permitted on managed Postgres. The GUC still works where set.
create or replace function staff_email_list() returns text
language sql stable security definer set search_path = public as $$
  select lower(coalesce(nullif(current_setting('app.staff_emails', true), ''), '')
         || ',' || coalesce((select string_agg(x, ',') from settings s, jsonb_array_elements_text(s.value) as x where s.key = 'staff_emails'), ''))
$$;

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := 'client';
  v_agency uuid := null;
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  if position(lower(new.email) in staff_email_list()) > 0 then
    v_role := 'staff';
  elsif v_meta ? 'agency_id' then
    v_agency := (v_meta ->> 'agency_id')::uuid;
    if v_meta ->> 'role' = 'staff' then v_role := 'staff'; end if;
  else
    select i.agency_id, i.role into v_agency, v_role from invites i
      where lower(i.email) = lower(new.email) and i.accepted_at is null order by i.invited_at desc limit 1;
    v_role := coalesce(v_role, 'client');
  end if;
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  update invites set accepted_at = now(), supabase_user_id = new.id
    where lower(email) = lower(new.email) and accepted_at is null;
  return new;
end $$;
