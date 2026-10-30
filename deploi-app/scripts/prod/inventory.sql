-- READ-ONLY inventory of a production database (Phase A, step 0). Run with psql; it changes nothing.
--   psql "$PROD_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/prod/inventory.sql
-- It prints counts, names of organizations, e-mail DOMAINS and date ranges only. No personal data rows.
\set QUIET on
\pset pager off
\pset null '(null)'
\echo '=== 1. server'
select version();
select current_database() as database, current_user as connected_as, (select rolsuper from pg_roles where rolname = current_user) as is_superuser;

\echo
\echo '=== 2. migration ledgers'
select to_regclass('public._migrations') is not null as has_ledger \gset
\if :has_ledger
select count(*) as recorded_migrations, min(name) as first, max(name) as last from public._migrations;
select name from public._migrations order by name;
\else
\echo '(no public._migrations table)'
\endif
select to_regclass('supabase_migrations.schema_migrations') is not null as has_supabase_ledger \gset
\if :has_supabase_ledger
select count(*) as supabase_ledger_rows from supabase_migrations.schema_migrations;
\else
\echo '(no supabase_migrations.schema_migrations)'
\endif

\echo
\echo '=== 3. every table: exact row count (schemas: public, auth, storage)'
select schemaname || '.' || relname as table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint as row_count
from pg_stat_user_tables where schemaname in ('public', 'auth', 'storage') order by 1;

\echo
\echo '=== 4. care (consulting) tables: rows and date range'
create temp table _care (t text);
insert into _care values ('assessments'),('trace_steps'),('clients'),('aides'),('authorizations'),('shifts'),('shift_offers'),('visits'),('evv_exceptions'),('referrals'),('applicants'),('proposed_actions'),('retention_checkins'),('worker_runs'),('evv_imports'),('assessment_credits'),('assessment_credit_applications'),('engagements'),('engagement_transitions'),('onboarding_items'),('pilots'),('pilot_measurements'),('job_runs'),('imports'),('visit_revisions'),('evv_rule_sets'),('internal_rates'),('labor_entries'),('cost_entries'),('revenue_entries'),('service_tickets'),('website_engagements'),('website_labor'),('website_transitions');
select count(*) filter (where p.tablename is not null) as care_tables_present, count(*) as care_tables_listed
from _care c left join pg_tables p on p.schemaname = 'public' and p.tablename = c.t;
select string_agg(
         format('select %L::text as care_table, count(*) as row_count, %s as first_created, %s as last_created from public.%I',
                p.tablename,
                case when k.has_created then 'min(created_at)' else 'null::timestamptz' end,
                case when k.has_created then 'max(created_at)' else 'null::timestamptz' end,
                p.tablename), E'\nunion all ' order by p.tablename) || E'\norder by 1' as one_query
from pg_tables p join _care c on c.t = p.tablename
cross join lateral (select exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = p.tablename and k.column_name = 'created_at') as has_created) k
where p.schemaname = 'public'
\gexec

\echo
\echo '=== 5. seeded / synthetic or real? evidence only'
\echo '-- organizations (business names)'
select id::text as org_id_prefix, name, state, created_at from (select left(id::text, 8) as id, name, state, created_at from public.agencies order by created_at) a;
\echo '-- sign-in profiles: role and e-mail domain only'
select p.role, split_part(lower(p.email), '@', 2) as email_domain, count(*) as profiles, min(p.created_at) as first_created, max(p.created_at) as last_created
from public.profiles p group by 1, 2 order by 1, 3 desc;
\echo '-- known demo seed markers (the old seed used Buckeye Home Care / Scioto Valley and *.example addresses)'
select (select count(*) from public.agencies where name ~* 'buckeye|scioto|synthetic|demo|example') as demo_named_orgs,
       (select count(*) from public.agencies) as all_orgs,
       (select count(*) from public.profiles where email ~* '\.example$') as example_domain_profiles,
       (select count(*) from public.profiles) as all_profiles;
\echo '-- early access applications (kept): count and date range'
select count(*) as prospects, min(created_at) as first_created, max(created_at) as last_created from public.prospects;

\echo
\echo '=== 6. who can call what anonymously (functions executable by anon, public schema)'
select p.oid::regprocedure::text as function, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by 1;

\echo
\echo '=== 7. staff configuration (counts only)'
select count(*) filter (where role = 'staff') as staff_profiles, count(*) filter (where role <> 'staff') as other_profiles from public.profiles;
select to_regclass('public.settings') is not null as has_settings \gset
\if :has_settings
select key, case when key ilike '%staff%' then 'set (value hidden)' else 'present' end as note from public.settings order by key;
\endif
\echo
\echo '=== end of inventory (nothing was changed)'
