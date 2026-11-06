#!/usr/bin/env bash
# Restore rehearsal (docs/BACKUP-RESTORE.md): dump a database, restore it into a fresh one, and prove the copy
# is complete and safe to serve:
#   1. every public table has the same row count in the copy as in the source
#   2. row-level security: the same tables have RLS on and the same policies; a signed-in session of an
#      organization that does not exist reads no organization's rows; the anonymous role reads no applicants
#   3. the tamper-evident audit trail verifies in the copy for every organization (verify_engine_audit_chain)
# Prints the dump size and how long the dump and the restore took (the restore time is the RTO input).
# Never touches production: it refuses a Supabase host unless --confirm-production is given, and even then
# it only reads the source and restores into a local database.
#
#   bash scripts/restore-rehearsal.sh [SOURCE_URL]      (default: DATABASE_URL from .env.test)
#   PGURL=postgres://postgres:postgres@127.0.0.1:5432 bash scripts/restore-rehearsal.sh
# Exit code 0 only when every check passed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGOPTIONS="-c client_min_messages=warning"
SRC=${1:-${SOURCE_URL:-}}
if [[ -z "$SRC" && -f .env.test ]]; then SRC=$(grep -E '^DATABASE_URL=' .env.test | head -1 | cut -d= -f2-); fi
[[ -n "$SRC" ]] || { echo "usage: restore-rehearsal.sh SOURCE_URL"; exit 2; }
if [[ "$SRC" == *supabase.co* || "$SRC" == *supabase.com* ]] && [[ "${2:-}" != "--confirm-production" ]]; then
  echo "refusing to read a Supabase database without --confirm-production"; exit 2
fi
PGURL=${PGURL:-postgres://postgres:postgres@127.0.0.1:5432}
DST_DB="restore_rehearsal_$$"
DST="$PGURL/$DST_DB"
WORK=$(mktemp -d)
cleanup() { psql -q "$PGURL/postgres" -c "drop database if exists $DST_DB" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "RESTORE REHEARSAL FAILED: $*"; exit 1; }

step "1. dump the source (custom format, schema + data)"
t0=$(date +%s%N)
pg_dump -Fc --quote-all-identifiers -f "$WORK/db.dump" "$SRC"
t1=$(date +%s%N)
echo "dump: $(du -h "$WORK/db.dump" | cut -f1) in $(( (t1 - t0) / 1000000 )) ms"

step "2. restore into a fresh database ($DST_DB)"
psql -q -v ON_ERROR_STOP=1 "$PGURL/postgres" -c "create database $DST_DB"
pg_restore --exit-on-error -d "$DST" "$WORK/db.dump"
t2=$(date +%s%N)
echo "restore: $(( (t2 - t1) / 1000000 )) ms"

COUNTS_SQL="
do \$\$ declare r record; n bigint; begin
  create temp table _counts (t text primary key, n bigint);
  for r in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p') order by 1 loop
    execute format('select count(*) from public.%I', r.relname) into n;
    insert into _counts values (r.relname, n);
  end loop;
end \$\$;
select t || '=' || n from _counts order by t;"

step "3. row counts match for every table"
psql -qtA -v ON_ERROR_STOP=1 "$SRC" -c "$COUNTS_SQL" > "$WORK/src_counts"
psql -qtA -v ON_ERROR_STOP=1 "$DST" -c "$COUNTS_SQL" > "$WORK/dst_counts"
TABLES=$(wc -l < "$WORK/src_counts"); ROWS=$(awk -F= '{s+=$2} END {print s}' "$WORK/src_counts")
diff -u "$WORK/src_counts" "$WORK/dst_counts" > "$WORK/counts.diff" || { head -40 "$WORK/counts.diff"; fail "row counts differ"; }
echo "row counts identical: $TABLES tables, $ROWS rows"

POLICY_SQL="select c.relname || ' rls=' || c.relrowsecurity || ' policies=' || coalesce((select string_agg(p.polname || ':' || p.polcmd::text, ',' order by p.polname) from pg_policy p where p.polrelid = c.oid), '')
  from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p') order by 1"

step "4. row-level security restored"
psql -qtA -v ON_ERROR_STOP=1 "$SRC" -c "$POLICY_SQL" > "$WORK/src_rls"
psql -qtA -v ON_ERROR_STOP=1 "$DST" -c "$POLICY_SQL" > "$WORK/dst_rls"
diff -u "$WORK/src_rls" "$WORK/dst_rls" > "$WORK/rls.diff" || { head -40 "$WORK/rls.diff"; fail "RLS settings or policies differ"; }
NO_RLS=$(grep -c ' rls=f' "$WORK/dst_rls" || true)
echo "RLS flags and policies identical ($(grep -c ' rls=t' "$WORK/dst_rls") tables with RLS on, $NO_RLS without)"
# functional: a session of an organization that does not exist reads nothing from org-scoped tables
LEAKS=$(psql -qtA -v ON_ERROR_STOP=1 "$DST" <<'SQL'
begin;
select set_config('request.jwt.claims', '{"role":"authenticated","org_id":"00000000-0000-4000-8000-00000000dead","actor":"restore-rehearsal"}', true);
set local role authenticated;
do $$ declare r record; n bigint; leaks int := 0; checked int := 0; begin
  for r in select distinct c.relname from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and pg_get_expr(p.polqual, p.polrelid) ~ 'org_id = current_org_id\(\)' order by 1 loop
    begin
      execute format('select count(*) from public.%I', r.relname) into n;
      checked := checked + 1;
      if n > 0 then leaks := leaks + 1; raise notice 'leak: % rows of %', n, r.relname; end if;
    exception when insufficient_privilege then checked := checked + 1;
    end;
  end loop;
  perform set_config('deploi.rehearsal', leaks || '/' || checked, true);
end $$;
select current_setting('deploi.rehearsal');
rollback;
SQL
)
LEAKS=$(echo "$LEAKS" | tail -1)
[[ "${LEAKS%%/*}" == "0" ]] || fail "an unknown organization's session read rows ($LEAKS tables)"
echo "unknown organization's session reads 0 rows in ${LEAKS##*/} org-scoped tables"
ANON=$(psql -qtA "$DST" -c "begin; set local role anon; select count(*) from prospects; rollback;" 2>/dev/null | grep -E '^[0-9]+$' || echo denied)
[[ "$ANON" == "0" || "$ANON" == "denied" ]] || fail "the anonymous role reads $ANON applicants"
echo "anonymous role reads no applicants ($ANON)"

step "5. audit hash chain verifies in the copy"
CHAIN=$(psql -qtA -v ON_ERROR_STOP=1 "$DST" -c "
  select count(*) || ' chains, ' || coalesce(sum(v.checked), 0) || ' rows, broken: ' || count(*) filter (where not v.ok)
  from (select distinct org_id from engine_audit) o cross join lateral verify_engine_audit_chain(o.org_id) v")
echo "$CHAIN"
[[ "$CHAIN" == *"broken: 0" ]] || fail "audit chain broken in the restored copy: $CHAIN"
SRCCHAIN=$(psql -qtA "$SRC" -c "select count(*) filter (where not v.ok) from (select distinct org_id from engine_audit) o cross join lateral verify_engine_audit_chain(o.org_id) v")
[[ "$SRCCHAIN" == "0" ]] || fail "the source's audit chain is already broken ($SRCCHAIN chains)"

echo
echo "RESTORE REHEARSAL PASSED: $TABLES tables, $ROWS rows, restore took $(( (t2 - t1) / 1000 / 1000 )) ms"
