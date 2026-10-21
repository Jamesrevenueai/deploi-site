-- Local-only effect: let service_role (which the app switches to for admin work) touch auth.users
-- in the self-hosted shim. On Supabase this grant is not permitted and is skipped.
do $$ begin
  grant select, insert, update, delete on auth.users to service_role;
exception when others then null; end $$;
