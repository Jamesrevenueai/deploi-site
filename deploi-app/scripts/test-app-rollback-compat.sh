#!/usr/bin/env bash
# Proves an app rollback is safe: the PREVIOUS app (origin/main by default) passes its own test suite against a
# database migrated with every migration on this branch. If this passes, "promote the previous Vercel deployment"
# is a complete app rollback with no database rollback. Local only; never touches a real database.
#   bash scripts/test-app-rollback-compat.sh [git-ref]
set -euo pipefail
cd "$(dirname "$0")/.."
REF=${1:-origin/main}
PGURL=${PGURL:-postgres://postgres:postgres@127.0.0.1:5432}
DB=rollback_compat
WT=$(mktemp -d)/previous
psql -q "$PGURL/postgres" -c "drop database if exists $DB" -c "create database $DB"
DATABASE_URL="$PGURL/$DB" npx tsx scripts/migrate.ts | tail -1
DATABASE_URL="$PGURL/$DB" npx tsx scripts/seed.ts | tail -1
git worktree add -q --detach "$WT" "$REF"
trap 'git worktree remove --force "$WT"; psql -q "$PGURL/postgres" -c "drop database if exists $DB"' EXIT
ln -s "$PWD/node_modules" "$WT/deploi-app/node_modules"
printf "DATABASE_URL=$PGURL/$DB\nAPP_SECRET=test-secret-test-secret-test-secret-123\nAUTH_MODE=dev\nSTAFF_EMAILS=hello@getdeploi.com\n" > "$WT/deploi-app/.env.test"
(cd "$WT/deploi-app" && npx vitest run 2>&1 | grep -E 'Test Files|Tests  ')
echo "previous app ($REF) runs on the fully migrated schema: ok"
