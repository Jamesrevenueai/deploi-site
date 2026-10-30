#!/usr/bin/env bash
# PHASE A, steps 0 and 1: read-only inventory, then a full backup with a restore check. Changes nothing in production.
#
#   export PROD_DATABASE_URL='postgres://...'        # from the Supabase dashboard (never paste it anywhere)
#   bash scripts/prod/phase-a.sh ./phase-a-$(date -u +%F) [postgres://...scratch-db-url]
#
# The optional second argument is an EMPTY local Postgres database used to prove the dump loads, for example:
#   createdb deploi_restore_check && bash scripts/prod/phase-a.sh ./out postgres://localhost/deploi_restore_check
# Then paste the contents of <out>/PASTE-THIS.txt back to the chat, and keep the *.dump file somewhere safe.
. "$(dirname "$0")/lib.sh"
URL=${PROD_DATABASE_URL:?set PROD_DATABASE_URL first}; OUT=${1:?usage: phase-a.sh <out-dir> [scratch-db-url]}; SCRATCH=${2:-}
need psql "install PostgreSQL client tools"; need pg_dump "install PostgreSQL client tools (version 15 or newer)"
cd "$(dirname "$0")/../.."; mkdir -p "$OUT"; SURL=$(session_url "$URL")
SERVER_MAJOR=$(psql -tA "$SURL" -c "show server_version_num" | cut -c1-2); DUMP_MAJOR=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
echo "server major: $SERVER_MAJOR, pg_dump major: $DUMP_MAJOR"; [[ "$DUMP_MAJOR" -ge "$SERVER_MAJOR" ]] || { echo "pg_dump is older than the server: install PostgreSQL $SERVER_MAJOR client tools"; exit 2; }

{ echo "PHASE A REPORT  $(date -u +%FT%TZ)  (commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown))"; echo "project ref: $(project_ref "$URL")"; hr; echo "STEP 0: INVENTORY (read only)"; psql "$SURL" -X -q -v ON_ERROR_STOP=1 -f scripts/prod/inventory.sql; } > "$OUT/inventory.txt" 2>&1 || { cat "$OUT/inventory.txt"; echo "INVENTORY FAILED"; exit 1; }
echo "inventory written: $OUT/inventory.txt"

{ hr; echo "STEP 1: BACKUP"; if [[ -n "$SCRATCH" ]]; then bash scripts/backup-before-launch.sh "$SURL" "$OUT" --verify-into "$SCRATCH"; else bash scripts/backup-before-launch.sh "$SURL" "$OUT"; echo "(restore check skipped: no scratch database given)"; fi; } > "$OUT/backup-summary.txt" 2>&1 || { cat "$OUT/backup-summary.txt"; echo "BACKUP FAILED"; exit 1; }
cat "$OUT/inventory.txt" "$OUT/backup-summary.txt" > "$OUT/PASTE-THIS.txt"
echo; echo "DONE. Paste the contents of $OUT/PASTE-THIS.txt into the chat. Keep $(ls "$OUT"/*.dump | head -1) safe: it is your production backup."
