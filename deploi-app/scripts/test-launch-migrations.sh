#!/usr/bin/env bash
# Tests the launch migrations (20261028000028..32) and their rollback on a COPY of a database in the
# state production is in today (migrations up to 20261021000027 plus existing care-agency data).
# Never touches production. Needs a local Postgres reachable as $PGURL (default postgres:postgres@127.0.0.1).
#
#   bash scripts/test-launch-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL=${PGURL:-postgres://postgres:postgres@127.0.0.1:5432}
export PGOPTIONS="-c client_min_messages=warning"
BASE=launch_base COPY=launch_copy
psqlq() { psql -q -v ON_ERROR_STOP=1 "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "1. build a database shaped like production today (migrations up to 027, plus data)"
psqlq "$PGURL/postgres" -c "drop database if exists $COPY" -c "drop database if exists $BASE" -c "create database $BASE"
psqlq "$PGURL/$BASE" -f supabase/local/0000_auth_shim.sql >/dev/null
psqlq "$PGURL/$BASE" -c "create table _migrations (name text primary key, applied_at timestamptz default now())"
for f in supabase/migrations/*.sql; do
  n=$(basename "$f"); [[ "$n" > "20261021000027_website.sql" ]] && continue
  psqlq "$PGURL/$BASE" -1 -f "$f" >/dev/null
  psqlq "$PGURL/$BASE" -c "insert into _migrations (name) values ('$n')"
done
psqlq "$PGURL/$BASE" <<'SQL'
insert into agencies (id, name) values ('00000000-0000-4000-8000-000000000a01', 'Existing Home Care LLC'), ('00000000-0000-4000-8000-000000000a02', 'Second Agency');
insert into prospects (agency_name, email, state, source, stage) values ('Lead One', 'lead1@example.com', 'OH', 'site', 'new');
SQL
pg_dump --schema-only --no-owner --no-privileges "$PGURL/$BASE" | grep -v '^--' | grep -v '^\\\(un\)\?restrict ' | sed '/^$/d' > /tmp/launch_before.sql
BEFORE_ROWS=$(psql -tA "$PGURL/$BASE" -c "select (select count(*) from agencies)||'/'||(select count(*) from prospects)")
echo "pre-launch rows (agencies/prospects): $BEFORE_ROWS"

step "2. copy it (the copy is what gets migrated)"
psqlq "$PGURL/postgres" -c "create database $COPY template $BASE"

step "3. production refusal: a Supabase host is refused without --confirm-production"
OUT=$(npx tsx scripts/launch-migrations.ts status --db "postgres://postgres.abcdefghijklmnopqrst:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres" 2>&1 || true)
if grep -q 'refusing to touch' <<<"$OUT"; then echo "refused: $OUT"; else echo "NOT REFUSED: $OUT"; exit 1; fi

step "4. dry run (one transaction, rolled back): nothing changes"
npx tsx scripts/launch-migrations.ts dry-run --db "$PGURL/$COPY"
npx tsx scripts/launch-migrations.ts status --db "$PGURL/$COPY"

step "5. apply"
npx tsx scripts/launch-migrations.ts apply --db "$PGURL/$COPY"
npx tsx scripts/launch-migrations.ts status --db "$PGURL/$COPY"
AFTER_ROWS=$(psql -tA "$PGURL/$COPY" -c "select (select count(*) from agencies)||'/'||(select count(*) from prospects)")
echo "rows after apply (agencies/prospects): $AFTER_ROWS"; [[ "$AFTER_ROWS" == "$BEFORE_ROWS" ]] || { echo "ROW COUNT CHANGED"; exit 1; }
psql -tA "$PGURL/$COPY" -c "select org_type, count(*) from agencies group by 1"

step "6. the app works on the migrated copy: merchant and platform tests against it"
MERCHANT_TEST_DATABASE_URL="$PGURL/$COPY" npx vitest run tests/merchant/platform.test.ts tests/merchant/agents.test.ts 2>&1 | grep -E 'Test Files|Tests  '

step "7. rollback refuses while launch tables hold data"
OUT=$(npx tsx scripts/launch-migrations.ts rollback --db "$PGURL/$COPY" 2>&1 || true)
if grep -q 'rollback refused' <<<"$OUT"; then echo "refused: $OUT"; else echo "NOT REFUSED: $OUT"; exit 1; fi
STILL=$(psql -tA "$PGURL/$COPY" -c "select count(*) from _migrations where name like '20261028%'")
echo "launch migrations still recorded after the refusal: $STILL of 5"; [[ "$STILL" == "5" ]] || { echo "PARTIAL ROLLBACK"; exit 1; }

step "8. rollback with --discard-data, then compare the schema with the original"
npx tsx scripts/launch-migrations.ts rollback --db "$PGURL/$COPY" --discard-data
pg_dump --schema-only --no-owner --no-privileges "$PGURL/$COPY" | grep -v '^--' | grep -v '^\\\(un\)\?restrict ' | sed '/^$/d' > /tmp/launch_after.sql
if diff -u /tmp/launch_before.sql /tmp/launch_after.sql > /tmp/launch_schema.diff; then echo "schema identical to the original: ok"; else echo "SCHEMA DIFFERS"; head -60 /tmp/launch_schema.diff; exit 1; fi
FINAL_ROWS=$(psql -tA "$PGURL/$COPY" -c "select (select count(*) from agencies where id::text like '00000000-0000-4000-8000-000000000a0%')||'/'||(select count(*) from prospects where email = 'lead1@example.com')")
echo "original rows still present (agencies/prospects): $FINAL_ROWS"; [[ "$FINAL_ROWS" == "2/1" ]] || { echo "ORIGINAL DATA LOST"; exit 1; }

step "9. apply again after rollback (re-runnable)"
npx tsx scripts/launch-migrations.ts apply --db "$PGURL/$COPY" >/dev/null && echo "re-apply: ok"
psqlq "$PGURL/postgres" -c "drop database $COPY" -c "drop database $BASE"
echo; echo "ALL LAUNCH MIGRATION CHECKS PASSED"
