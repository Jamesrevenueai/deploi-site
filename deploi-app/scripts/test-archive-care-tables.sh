#!/usr/bin/env bash
# Rehearses scripts/archive-care-tables.ts (tables and consulting functions) on COPIES of production-shaped databases. Never touches production.
# Needs a local Postgres reachable as $PGURL (default postgres:postgres@127.0.0.1) and pg_dump/pg_restore on PATH.
#
#   bash scripts/test-archive-care-tables.sh [021|027]
#     021  production as its logs show it: older than migration 022, so only some care tables exist (default)
#     027  the full consulting schema, for tables that all exist
set -euo pipefail
cd "$(dirname "$0")/.."
CUT=${1:-021}
PGURL=${PGURL:-postgres://postgres:postgres@127.0.0.1:5432}
export PGOPTIONS="-c client_min_messages=warning"
BASE=archive_base_$CUT COPY=archive_copy_$CUT CHECK=archive_dumpcheck_$CUT
DUMP=${DUMP_DIR:-/tmp}/care-tables-$CUT.dump
psqlq() { psql -q -v ON_ERROR_STOP=1 "$@"; }
step() { printf '\n== %s\n' "$*"; }
CLI="npx tsx scripts/archive-care-tables.ts"
LAST=$(ls supabase/migrations | awk -v c="20261021000$CUT" '$0 <= c"_zzz"' | tail -1)

step "1. build a database shaped like production (consulting migrations up to $CUT, then the launch migrations)"
psqlq "$PGURL/postgres" -c "drop database if exists $COPY" -c "drop database if exists $CHECK" -c "drop database if exists $BASE" -c "create database $BASE"
psqlq "$PGURL/$BASE" -f supabase/local/0000_auth_shim.sql >/dev/null
psqlq "$PGURL/$BASE" -c "create table _migrations (name text primary key, applied_at timestamptz default now())"
for f in supabase/migrations/*.sql; do
  n=$(basename "$f"); [[ "$n" > "$LAST" ]] && continue
  psqlq "$PGURL/$BASE" -1 -f "$f" >/dev/null; psqlq "$PGURL/$BASE" -c "insert into _migrations (name) values ('$n')"
done
npx tsx scripts/launch-migrations.ts apply --db "$PGURL/$BASE" >/dev/null
psqlq "$PGURL/$BASE" -c "insert into agencies (id, name) values ('00000000-0000-4000-8000-000000000a01', 'Synthetic Home Care LLC'), ('00000000-0000-4000-8000-000000000a02', 'Synthetic Second Agency')"
npx tsx scripts/archive-rehearsal-seed.ts "$PGURL/$BASE"

step "2. copy it (the copy is what gets archived)"
psqlq "$PGURL/postgres" -c "create database $COPY template $BASE"
URL="$PGURL/$COPY"

step "3. refusals: production host without --confirm-production; apply without a dump"
OUT=$($CLI report --db "postgres://postgres.abcdefghijklmnopqrst:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres" 2>&1 || true)
grep -q 'refusing to touch' <<<"$OUT" && echo "refused: production host" || { echo "NOT REFUSED: $OUT"; exit 1; }
OUT=$($CLI apply --db "$URL" --dump /tmp/does-not-exist.dump 2>&1 || true)
grep -q 'must all exist' <<<"$OUT" && echo "refused: no dump" || { echo "NOT REFUSED: $OUT"; exit 1; }

step "4. report (read only): tables, row counts, blockers"
$CLI report --db "$URL"
CARE_SQL="select string_agg(quote_literal(t), ',') from unnest(array['assessments','trace_steps','clients','aides','authorizations','shifts','shift_offers','visits','evv_exceptions','referrals','applicants','proposed_actions','retention_checkins','worker_runs','evv_imports','assessment_credits','assessment_credit_applications','engagements','engagement_transitions','onboarding_items','pilots','pilot_measurements','job_runs','imports','visit_revisions','evv_rule_sets','internal_rates','labor_entries','cost_entries','revenue_entries','service_tickets','website_engagements','website_labor','website_transitions']) t"
CARE_LIST=$(psql -tA "$URL" -c "$CARE_SQL")
ROWS_BEFORE=$(psql -tA "$URL" -c "select coalesce(sum((xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(tablename), false, true, '')))[1]::text::int),0) from pg_tables where schemaname='public' and tablename in ($CARE_LIST)")
KEPT_BEFORE=$(psql -tA "$URL" -c "select (select count(*) from agencies)||'/'||(select count(*) from prospects)||'/'||(select count(*) from profiles)")
GRANTS_BEFORE=$(psql -tA "$URL" -c "select md5(string_agg(table_name||grantee||privilege_type, ',' order by table_name, grantee, privilege_type)) from information_schema.role_table_grants where table_schema='public' and table_name in ($CARE_LIST)")
FN_LIST="'public_create_lead','public_create_lead_v2','website_strip_secret_keys','suppress_pending_actions','agency_last_worker_run','retire_followups_on_change','audit_internal_rates_row','engagements_status_guard'"
FN_FP="select count(*)||'/'||coalesce(md5(string_agg(p.oid::regprocedure::text||has_function_privilege('anon',p.oid,'execute')||has_function_privilege('authenticated',p.oid,'execute')||has_function_privilege('service_role',p.oid,'execute'), ',' order by p.oid::regprocedure::text)),'') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ($FN_LIST)"
FN_BEFORE=$(psql -tA "$URL" -c "$FN_FP"); FN_COUNT=${FN_BEFORE%%/*}
ANON_RPC=$(psql -tA "$URL" -c "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('public_create_lead','public_create_lead_v2','suppress_pending_actions','agency_last_worker_run') and has_function_privilege('anon', p.oid, 'execute')")
echo "care rows before: $ROWS_BEFORE; kept rows (agencies/prospects/profiles): $KEPT_BEFORE; grants fingerprint: $GRANTS_BEFORE"
echo "consulting functions before: $FN_COUNT (anon can run $ANON_RPC of the lead-intake and worker functions)"

step "5. dump (the backup of exactly these tables) and prove the dump loads and matches"
$CLI dump --db "$URL" --out "$DUMP"
psqlq "$PGURL/postgres" -c "create database $CHECK"
psqlq "$PGURL/$CHECK" -f supabase/local/0000_auth_shim.sql >/dev/null
pg_dump --schema-only --no-owner --no-privileges "$PGURL/$BASE" | psql -q "$PGURL/$CHECK" >/dev/null 2>&1 || true
pg_restore --data-only --disable-triggers --no-owner -d "$PGURL/$CHECK" "$DUMP"
MISMATCH=0
while IFS=$'\t' read -r t n; do
  got=$(psql -tA "$PGURL/$CHECK" -c "select count(*) from public.$t")
  [[ "$got" == "$n" ]] || { echo "DUMP MISMATCH $t: manifest $n, restored $got"; MISMATCH=1; }
done < "$DUMP.counts.tsv"
[[ $MISMATCH == 0 ]] && echo "dump restores into a scratch database with every table's row count equal to the manifest ($(wc -l < "$DUMP.counts.tsv") tables)" || exit 1

step "6. apply: move to schema archive, revoke app roles, verify counts (one transaction)"
$CLI apply --db "$URL" --dump "$DUMP"
$CLI verify --db "$URL"
ROWS_ARCHIVED=$(psql -tA "$URL" -c "select coalesce(sum(rows_at_archive),0) from archive._archive_log")
KEPT_AFTER=$(psql -tA "$URL" -c "select (select count(*) from agencies)||'/'||(select count(*) from prospects)||'/'||(select count(*) from profiles)")
echo "care rows before: $ROWS_BEFORE, in archive: $ROWS_ARCHIVED; kept rows after: $KEPT_AFTER"
[[ "$ROWS_BEFORE" == "$ROWS_ARCHIVED" ]] || { echo "ROW COUNT MISMATCH"; exit 1; }
[[ "$KEPT_BEFORE" == "$KEPT_AFTER" ]] || { echo "KEPT TABLES CHANGED"; exit 1; }
LEFT=$(psql -tA "$URL" -c "select count(*) from pg_tables where schemaname='public' and tablename in ($CARE_LIST)")
echo "care tables left in public: $LEFT"; [[ "$LEFT" == "0" ]] || exit 1
FN_LEFT=$(psql -tA "$URL" -c "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ($FN_LIST)")
FN_ARCH=$(psql -tA "$URL" -c "select count(*) from archive._archive_functions")
ANON_AFTER=$(psql -tA "$URL" -c "select count(*) from pg_proc p where p.pronamespace='archive'::regnamespace and has_function_privilege('anon', p.oid, 'execute')")
echo "consulting functions: $FN_COUNT before, $FN_ARCH archived, $FN_LEFT left in public; anon can run $ANON_AFTER archived functions"
[[ "$FN_LEFT" == "0" && "$FN_ARCH" == "$FN_COUNT" && "$ANON_AFTER" == "0" ]] || { echo "FUNCTION ARCHIVE WRONG"; exit 1; }

step "7. app roles cannot read or write the archive"
for role in authenticated service_role anon; do
  psql -tA "$URL" -c "select 1 from pg_roles where rolname='$role'" | grep -q 1 || continue
  OUT=$(psql -q "$URL" -c "set role $role; select count(*) from archive.$(psql -tA "$URL" -c "select table_name from archive._archive_log order by 1 limit 1")" 2>&1 || true)
  grep -q 'permission denied' <<<"$OUT" && echo "$role: permission denied (as required)" || { echo "$role CAN READ: $OUT"; exit 1; }
done

step "8. idempotent: a second apply does nothing"
$CLI apply --db "$URL" --dump "$DUMP"

step "9. the app works on the archived copy: merchant, platform and early access tests against it"
MERCHANT_TEST_DATABASE_URL="$URL" npx vitest run tests/merchant/platform.test.ts tests/merchant/agents.test.ts 2>&1 | grep -E 'Test Files|Tests  '
WEB_TEST_DATABASE_URL="$URL" npx vitest run tests/api/lead.test.ts 2>&1 | grep -E 'Test Files|Tests  '

step "10. drop is refused inside 30 days"
OUT=$($CLI drop --db "$URL" --confirm-drop 2>&1 || true)
grep -q 'archive is kept for 30 days' <<<"$OUT" && echo "refused: $OUT" || { echo "NOT REFUSED: $OUT"; exit 1; }
OUT=$($CLI drop --db "$URL" 2>&1 || true); grep -q 'confirm-drop' <<<"$OUT" && echo "refused without --confirm-drop"

step "11. restore (rollback): tables return to public, grants return, counts and grants match the original"
$CLI restore --db "$URL"
ROWS_RESTORED=$(psql -tA "$URL" -c "select coalesce(sum((xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(tablename), false, true, '')))[1]::text::int),0) from pg_tables where schemaname='public' and tablename in ($CARE_LIST)")
GRANTS_AFTER=$(psql -tA "$URL" -c "select md5(string_agg(table_name||grantee||privilege_type, ',' order by table_name, grantee, privilege_type)) from information_schema.role_table_grants where table_schema='public' and table_name in ($CARE_LIST)")
FN_AFTER=$(psql -tA "$URL" -c "$FN_FP")
echo "care rows restored: $ROWS_RESTORED (was $ROWS_BEFORE); grants fingerprint $GRANTS_AFTER (was $GRANTS_BEFORE); functions+rights fingerprint $FN_AFTER (was $FN_BEFORE)"
[[ "$ROWS_RESTORED" == "$ROWS_BEFORE" && "$GRANTS_AFTER" == "$GRANTS_BEFORE" && "$FN_AFTER" == "$FN_BEFORE" ]] || { echo "RESTORE DIFFERS"; exit 1; }

step "12. archive again after the restore (re-runnable)"
$CLI dump --db "$URL" --out "$DUMP" >/dev/null
$CLI apply --db "$URL" --dump "$DUMP"
$CLI verify --db "$URL"

echo; echo "ALL ARCHIVE CHECKS PASSED (shape $CUT)"
