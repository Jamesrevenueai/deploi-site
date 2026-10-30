#!/usr/bin/env bash
# PHASE D, step 5: archive the care tables and consulting functions. Run ONLY after the new app is live and you said go.
#
#   export PROD_DATABASE_URL='postgres://...'
#   bash scripts/prod/phase-d.sh <project-ref> ./phase-d-$(date -u +%F)
# Paste <out>/PASTE-THIS.txt back. Keep <out>/care-tables.dump safe: it is the only copy once the archive is dropped (30 days later).
. "$(dirname "$0")/lib.sh"
URL=${PROD_DATABASE_URL:?set PROD_DATABASE_URL first}; REF=${1:?usage: phase-d.sh <project-ref> <out-dir>}; OUT=${2:?out dir}
need psql "PostgreSQL client"; need pg_dump "PostgreSQL client"; need npx "Node.js 20+"
cd "$(dirname "$0")/../.."; mkdir -p "$OUT"
[[ "${DEPLOI_RUNBOOK_TEST:-}" == 1 || "$(project_ref "$URL")" == "$REF" ]] || { echo "GATE FAIL: the URL's project ref is not $REF"; exit 1; }
[[ -d node_modules/.bin ]] || npm ci --no-audit --no-fund >/dev/null
SURL=$(session_url "$URL"); A="npx tsx scripts/archive-care-tables.ts"; C="--confirm-production=$REF"
{
echo "PHASE D REPORT  $(date -u +%FT%TZ)  (commit $(git rev-parse --short HEAD))"; hr
echo "-- report (read only)"; $A report --db "$SURL" $C || { echo "GATE FAIL: report failed or found blockers; nothing was changed"; exit 1; }
echo "-- dump"; $A dump --db "$SURL" --out "$OUT/care-tables.dump" $C
echo "-- apply (one transaction)"; $A apply --db "$SURL" --dump "$OUT/care-tables.dump" $C || { echo "GATE FAIL: apply refused or failed; public is unchanged"; exit 1; }
echo "-- verify"; $A verify --db "$SURL" $C || { echo "GATE FAIL: verify failed; run: $A restore --db <url> $C"; exit 1; }
echo "-- migration ledger guard: the retired consulting migrations are skipped by scripts/migrate.ts"
echo "RESULT: PASS. Drop-after-30-days TODO: select min(archived_at) + interval '30 days' from archive._archive_log;"
} 2>&1 | tee "$OUT/PASTE-THIS.txt"
