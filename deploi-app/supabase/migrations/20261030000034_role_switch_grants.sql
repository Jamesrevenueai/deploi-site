-- On Postgres 16+ (Neon, any managed Postgres without Supabase) the login role that created
-- anon/authenticated/service_role holds ADMIN on them but not SET, so `set local role ...`
-- fails with "permission denied to set role" and every request transaction aborts.
-- Grant the connection role SET on the three roles. No-op where it already can (superuser,
-- Supabase); errors are ignored so this never blocks a migration run.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('grant %I to %I with set true, inherit false', r, current_user);
      exception when others then
        raise notice 'role switch grant for % skipped: %', r, sqlerrm;
      end;
    end if;
  end loop;
end $$;
