-- Read-only checks (2026-11-07). Every statement below is a SELECT: nothing is changed.
-- Paste PART 1 into the SQL editor of deploi-preview (bhddgjcefwasdyrrfptc) and PART 2 into deploi-prod
-- (makqaqzlylhckijdbjzi). Send me the result rows (you can blank out email addresses if you prefer).

-- ================================================================================================
-- PART 1: deploi-preview (bhddgjcefwasdyrrfptc). Expect one row, every column true.
-- ================================================================================================
select
  exists (select 1 from _migrations where name = '20261107000064_app_redesign.sql')            as migration_064_recorded,
  (select relrowsecurity from pg_class where oid = 'public.agent_profiles'::regclass)        as rls_agent_profiles,
  (select relrowsecurity from pg_class where oid = 'public.agent_instructions'::regclass)    as rls_agent_instructions,
  (select relrowsecurity from pg_class where oid = 'public.app_workspace_prefs'::regclass)   as rls_app_workspace_prefs,
  (select relrowsecurity from pg_class where oid = 'public.agent_chat_messages'::regclass)   as rls_agent_chat_messages,
  (select count(*) = 4 from pg_policies where schemaname = 'public' and policyname in
     ('agent_profiles_org_read','agent_instructions_org_read','app_workspace_prefs_org_read','agent_chat_messages_org_read')) as read_policies_present,
  not has_table_privilege('anon', 'public.agent_chat_messages', 'select')                   as anon_cannot_read_chat,
  not has_table_privilege('authenticated', 'public.agent_chat_messages', 'insert')          as users_cannot_write_chat;

-- ================================================================================================
-- PART 2: deploi-prod (makqaqzlylhckijdbjzi). F-02 audit (from docs/HOTFIX-F02.md step 2) + state.
-- ================================================================================================
-- 2a. Who is staff, and did anyone claim a role or organization at sign-up?
--     is_listed_staff must be true on every staff row; any non-null claimed_role / claimed_org is suspicious.
select p.id, p.email, p.role, p.agency_id, p.created_at, u.created_at as auth_created_at, u.invited_at,
       lower(p.email) in ('hello@getdeploi.com', 'omarjames908@gmail.com') as is_listed_staff,
       u.raw_user_meta_data ->> 'role'      as claimed_role,
       u.raw_user_meta_data ->> 'agency_id' as claimed_org,
       u.raw_app_meta_data  ->> 'provider'  as provider
from profiles p join auth.users u on u.id = p.id
where p.role = 'staff' or u.raw_user_meta_data ? 'role' or u.raw_user_meta_data ? 'agency_id'
order by p.created_at;

-- 2b. Is the database patch already in? (false/false/false = the SQL hotfix is still needed)
select position('''raw_user_meta_data''' in pg_get_functiondef('public.handle_new_user'::regproc)) = 0 as fixed_trigger,
       not has_table_privilege('authenticated', 'public.leads', 'select')                              as leads_closed,
       not has_function_privilege('anon', 'public.staff_email_list()', 'execute')                       as staff_list_closed;

-- 2c. How many accounts exist and when the newest was created.
select count(*) as users_total, max(created_at) as newest_user from auth.users;
