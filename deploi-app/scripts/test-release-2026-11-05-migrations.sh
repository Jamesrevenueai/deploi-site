#!/usr/bin/env bash
# Rehearses the 2026-11-05 release migrations (045..051) and their rollback on a COPY of a database shaped like
# production today: every live migration up to 20261030000035 (the retired consulting migrations are skipped,
# as scripts/migrate.ts does), plus existing merchant data. Never touches production or any Supabase project.
# Needs a local Postgres reachable as $PGURL (default postgres:postgres@127.0.0.1).
#
#   bash scripts/test-release-2026-11-05-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL=${PGURL:-postgres://postgres:postgres@127.0.0.1:5432}
export PGOPTIONS="-c client_min_messages=warning"
BASE=release5_base COPY=release5_copy SET=--set=2026-11-05
TMP=${TMPDIR:-/tmp}
psqlq() { psql -q -v ON_ERROR_STOP=1 "$@"; }
step() { printf '\n== %s\n' "$*"; }
RETIRED=$(npx tsx -e "import { RETIRED_MIGRATIONS } from './scripts/retired-migrations'; console.log(RETIRED_MIGRATIONS.join(' '))")

step "1. build a database shaped like production today (live migrations through 20261104000044, plus merchant data)"
psqlq "$PGURL/postgres" -c "drop database if exists $COPY" -c "drop database if exists $BASE" -c "create database $BASE"
psqlq "$PGURL/$BASE" -f supabase/local/0000_auth_shim.sql >/dev/null
psqlq "$PGURL/$BASE" -c "create table _migrations (name text primary key, applied_at timestamptz default now())"
for f in supabase/migrations/*.sql; do
  n=$(basename "$f"); [[ "$n" > "20261104000044_zzz" ]] && continue
  [[ " $RETIRED " == *" $n "* ]] && continue
  psqlq "$PGURL/$BASE" -1 -f "$f" >/dev/null
  psqlq "$PGURL/$BASE" -c "insert into _migrations (name) values ('$n')"
done
psqlq "$PGURL/$BASE" <<'SQL'
insert into agencies (id, name, org_type) values ('00000000-0000-4000-8000-000000000b01', 'Existing Merchant LLC', 'merchant'), ('00000000-0000-4000-8000-000000000b02', 'Second Merchant', 'merchant');
insert into store_connections (id, org_id, platform, external_id, status) values ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-000000000b01', 'shopify', 'existing-merchant.myshopify.com', 'active');
SQL
pg_dump --schema-only --no-owner --no-privileges "$PGURL/$BASE" | grep -v '^--' | grep -v '^\\\(un\)\?restrict ' | sed '/^$/d' > "$TMP/release5_before.sql"
ROWS="select (select count(*) from agencies where id::text like '00000000-0000-4000-8000-000000000b0%')||'/'||(select count(*) from store_connections where id = '00000000-0000-4000-8000-000000000c01')"
BEFORE_ROWS=$(psql -tA "$PGURL/$BASE" -c "$ROWS"); echo "pre-release rows (merchants/stores): $BEFORE_ROWS"

step "2. copy it (the copy is what gets migrated)"
psqlq "$PGURL/postgres" -c "create database $COPY template $BASE"

step "3. production refusal: a Supabase host is refused without --confirm-production"
OUT=$(npx tsx scripts/launch-migrations.ts status $SET --db "postgres://postgres.abcdefghijklmnopqrst:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres" 2>&1 || true)
if grep -q 'refusing to touch' <<<"$OUT"; then echo "refused: ok"; else echo "NOT REFUSED: $OUT"; exit 1; fi

step "4. dry run (one transaction, rolled back): nothing changes"
npx tsx scripts/launch-migrations.ts dry-run $SET --db "$PGURL/$COPY"
N=$(psql -tA "$PGURL/$COPY" -c "select count(*) from _migrations where name like '20261105%'"); [[ "$N" == "0" ]] || { echo "DRY RUN LEFT $N MIGRATIONS"; exit 1; }
echo "dry run left nothing: ok"

step "5. apply"
npx tsx scripts/launch-migrations.ts apply $SET --db "$PGURL/$COPY"
npx tsx scripts/launch-migrations.ts status $SET --db "$PGURL/$COPY"
AFTER_ROWS=$(psql -tA "$PGURL/$COPY" -c "$ROWS"); [[ "$AFTER_ROWS" == "$BEFORE_ROWS" ]] || { echo "ROW COUNT CHANGED: $AFTER_ROWS"; exit 1; }

step "6. the app works on the migrated copy"
MERCHANT_TEST_DATABASE_URL="$PGURL/$COPY" npx vitest run tests/integration tests/security tests/infra/email.test.ts tests/woocommerce/agents.test.ts tests/office/lead-followup.test.ts tests/legal 2>&1 | grep -E 'Test Files|Tests  '

step "7a. rolling this release back is refused while a later release is applied"
LATER=$(psql -tA "$PGURL/$COPY" -c "select count(*) from _migrations where name like '20261106%'")
if [[ "$LATER" != "0" ]]; then
  OUT=$(npx tsx scripts/launch-migrations.ts rollback $SET --db "$PGURL/$COPY" --discard-data 2>&1 || true)
  if grep -q 'roll back the later release first' <<<"$OUT"; then echo "refused while 2026-11-06 is applied: ok"; else echo "NOT REFUSED: $OUT"; exit 1; fi
  npx tsx scripts/launch-migrations.ts rollback --set=2026-11-06 --db "$PGURL/$COPY" --discard-data >/dev/null && echo "later release (2026-11-06) rolled back first: ok"
fi

step "7. rollback refuses while release tables hold data"
psqlq "$PGURL/$COPY" -c "insert into cases (org_id, suite, kind, source_app, dedupe_key, title, problem, verification) values ('00000000-0000-4000-8000-000000000b01', 'commerce', 'rehearsal_case', 'import', 'rehearsal:1', 'Rehearsal case', 'kept to test the rollback guard', '{\"criteria\": \"rehearsal\"}')"
OUT=$(npx tsx scripts/launch-migrations.ts rollback $SET --db "$PGURL/$COPY" 2>&1 || true)
if grep -q 'rollback refused' <<<"$OUT"; then echo "refused: $(grep -o 'rollback refused.*' <<<"$OUT" | head -1)"; else echo "NOT REFUSED: $OUT"; exit 1; fi
EXPECTED=$(ls supabase/migrations/20261105*.sql | wc -l | tr -d " ")
STILL=$(psql -tA "$PGURL/$COPY" -c "select count(*) from _migrations where name like '20261105%'"); [[ "$STILL" == "$EXPECTED" ]] || { echo "PARTIAL ROLLBACK: $STILL of $EXPECTED"; exit 1; }
echo "all $EXPECTED release migrations still recorded after the refusal: ok"

step "8. rollback with --discard-data, then compare the schema with the original"
npx tsx scripts/launch-migrations.ts rollback $SET --db "$PGURL/$COPY" --discard-data
pg_dump --schema-only --no-owner --no-privileges "$PGURL/$COPY" | grep -v '^--' | grep -v '^\\\(un\)\?restrict ' | sed '/^$/d' > "$TMP/release5_after.sql"
# The rollback of 042 deliberately keeps the security hardening F-01..F-05 (sign-up trusts only app metadata,
# staff is an exact address match, the leads view runs as the caller, the migration ledger has RLS): undoing it
# would reopen those findings. Every other line must match the original schema exactly.
KEPT='a^' # no kept lines: every 2026-11-05 rollback must restore the schema exactly
diff -u "$TMP/release5_before.sql" "$TMP/release5_after.sql" > "$TMP/release5_schema.diff" || true
UNEXPECTED=$(grep -E '^[+-][^+-]' "$TMP/release5_schema.diff" | grep -vE "$KEPT" || true)
if [[ -z "$UNEXPECTED" ]]; then echo "schema identical to the original byte for byte: ok"; else echo "SCHEMA DIFFERS"; echo "$UNEXPECTED" | head -60; exit 1; fi
FINAL_ROWS=$(psql -tA "$PGURL/$COPY" -c "$ROWS"); [[ "$FINAL_ROWS" == "$BEFORE_ROWS" ]] || { echo "ORIGINAL DATA LOST: $FINAL_ROWS"; exit 1; }
echo "original rows still present: ok"

step "9. apply again after rollback (re-runnable)"
npx tsx scripts/launch-migrations.ts apply $SET --db "$PGURL/$COPY" >/dev/null && echo "re-apply: ok"
psqlq "$PGURL/postgres" -c "drop database $COPY" -c "drop database $BASE"
echo; echo "ALL RELEASE MIGRATION CHECKS PASSED"
