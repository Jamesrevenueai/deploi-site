-- Run in the Supabase SQL editor of deploi-PREVIEW (bhddgjcefwasdyrrfptc) ONLY. Never in deploi-prod.
-- Why (2026-11-11): old preview builds still connect with the old app login (not "postgres"); the Monday reset changed
-- only "postgres". Old builds also still have the test sign-in compiled in, so they must lose the database before
-- Vercel Authentication can be switched off. The current preview uses DATABASE_URL_POOLED (the "postgres" login) and
-- is not affected.

-- 1) Which logins exist (read-only). Expect "postgres" plus Supabase's own roles, and the old app login (e.g. deploi_app).
select rolname, rolcanlogin from pg_roles
where rolcanlogin and rolname not like 'pg\_%' and rolname not like 'supabase%'
  and rolname not in ('postgres', 'authenticator', 'pgbouncer', 'dashboard_user', 'pgsodium_keyholder', 'cli_login_postgres')
order by 1;

-- 2) Block every custom app login (any login role whose name starts with "deploi"): cuts off all old builds at once.
--    Undo if ever needed: alter role <name> login;
do $$
declare r text;
begin
  for r in select rolname from pg_roles where rolcanlogin and rolname like 'deploi%' loop
    execute format('alter role %I nologin', r);
    raise notice 'blocked login: %', r;
  end loop;
end $$;

-- 3) End their open connections so the block takes effect now.
select pg_terminate_backend(pid), usename from pg_stat_activity where usename like 'deploi%';
