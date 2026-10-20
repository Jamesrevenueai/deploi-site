-- Item 8: staff-only key/value settings (templates, booking URL) for the /staff/setup readiness page.
create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table settings enable row level security;
drop policy if exists settings_staff_all on settings;
create policy settings_staff_all on settings for all to authenticated using (is_staff()) with check (is_staff());
grant all on settings to authenticated, service_role;

-- audit_row() keys on new.id; settings has a text primary key, so a dedicated trigger logs the key.
create or replace function audit_settings_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  values (auth.uid(), null, 'settings', coalesce(new.key, old.key), lower(tg_op), nullif(current_setting('app.ip', true), ''));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists audit_settings on settings;
create trigger audit_settings after insert or update or delete on settings for each row execute function audit_settings_row();
