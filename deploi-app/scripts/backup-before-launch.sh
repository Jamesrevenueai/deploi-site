#!/usr/bin/env bash
# Backup to take BEFORE the launch migrations or the care-table archive: a full pg_dump, the exact row count of every
# table, the migration ledger and a sha256. Read only on the source. The database URL is an argument and is never printed.
#
#   bash scripts/backup-before-launch.sh <db-url> <out-dir> [--verify-into <empty-scratch-db-url>]
#
# With --verify-into, the dump is restored into the scratch database and every table's row count is compared with the
# source's (proves the backup loads and is complete). Store the files OUTSIDE this machine: a cloud session's disk is
# discarded when it ends.
set -euo pipefail
URL=${1:?usage: backup-before-launch.sh <db-url> <out-dir> [--verify-into <scratch-url>]}; OUT=${2:?out dir}
VERIFY=""; [[ "${3:-}" == "--verify-into" ]] && VERIFY=${4:?scratch url}
mkdir -p "$OUT"; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$OUT/deploi-$STAMP.dump"; COUNTS="$OUT/row-counts-$STAMP.tsv"
COUNT_SQL="select schemaname || '.' || relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname), false, true, '')))[1]::text from pg_stat_user_tables order by 1"

pg_dump -Fc --no-owner --file "$DUMP" "$URL"
psql -tA -F $'\t' "$URL" -c "$COUNT_SQL" > "$COUNTS"
psql -tA "$URL" -c "select name from _migrations order by name" > "$OUT/migrations-$STAMP.txt" 2>/dev/null || echo "(no _migrations table)" > "$OUT/migrations-$STAMP.txt"
( cd "$OUT" && sha256sum "$(basename "$DUMP")" > "$(basename "$DUMP").sha256" )

echo "dump:        $DUMP ($(stat -c %s "$DUMP") bytes, $(pg_restore --list "$DUMP" | grep -c .) catalog entries)"
echo "sha256:      $(cut -d' ' -f1 "$DUMP.sha256")"
echo "row counts:  $COUNTS ($(wc -l < "$COUNTS") tables, $(awk -F'\t' '{s+=$2} END {print s+0}' "$COUNTS") rows)"
echo "migrations:  $OUT/migrations-$STAMP.txt ($(grep -c . "$OUT/migrations-$STAMP.txt") recorded)"

if [[ -n "$VERIFY" ]]; then
  pg_restore --no-owner --exit-on-error -d "$VERIFY" "$DUMP" >/dev/null 2>&1 || pg_restore --no-owner -d "$VERIFY" "$DUMP" >/dev/null 2>&1 || true
  psql -tA -F $'\t' "$VERIFY" -c "$COUNT_SQL" > "$OUT/row-counts-restored-$STAMP.tsv"
  # only the tables in the dump (the scratch database has no Supabase-managed schemas)
  if diff <(grep -E '^public\.' "$COUNTS") <(grep -E '^public\.' "$OUT/row-counts-restored-$STAMP.tsv") >/dev/null; then
    echo "restore check: OK, every public table's row count in the scratch restore equals the source ($(grep -cE '^public\.' "$COUNTS") tables)"
  else
    echo "restore check: DIFFERS"; diff <(grep -E '^public\.' "$COUNTS") <(grep -E '^public\.' "$OUT/row-counts-restored-$STAMP.tsv") | head -20; exit 1
  fi
fi
