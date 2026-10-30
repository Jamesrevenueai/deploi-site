# Production launch, 2026-10-30

What was done to production, in order, and how to undo each step. Every database step ran over HTTPS through the
Supabase Management API (`POST /v1/projects/{ref}/database/query`), because direct Postgres ports are not reachable
from cloud sessions. The scripts are in `scripts/ops-http/`. They send no auth header: the session's network proxy
injects the Supabase access token.

| Step | Result |
|---|---|
| Inventory of deploi-prod (`makqaqzlylhckijdbjzi`) | ledger at `20261020000016`; 23 tables, 2,859 rows; 4 auth users; all care data synthetic (`.example` / `example.com` addresses) |
| Backup | `scripts/ops-http/backup.py`: catalog, regenerated DDL, the 12 applied migration files, every row as JSON, sha256 manifest. Recount after export matched |
| Restore check | `scripts/ops-http/restore_check.py` into a scratch Postgres: 24 tables, 2,859 rows, 277 columns, 24 policies identical |
| Backup location | Supabase Storage, project deploi-prod, private bucket `backups`: `backup-prod-2026-10-30.tar.gz` (+ `.sha256`) |
| Preview split | new free project deploi-preview (`bhddgjcefwasdyrrfptc`, us-east-2, Deploi Ai org), 25 migrations, synthetic seed. Production-only targets on DATABASE_URL and the Supabase variables |
| Launch migrations | `scripts/ops-http/launch.py dry-run`, then `apply`: 028 to 034 (8 files). Ledger 12 to 20, every existing row count unchanged |
| Ship | PR #1 merged at the tested tip `fb895e5` (merge commit `b4f68af`) |
| Archive | `scripts/ops-http/archive.py report / dump / apply / verify`: 15 care tables (622 rows) and `public_create_lead()` moved to schema `archive`; anon, authenticated and service_role denied. Dump in the `backups` bucket: `care-tables-archive-2026-10-30.tar.gz` |
| APP_SECRET | rotated on Production; Preview has its own value |
| Second backup | taken at ~14:45 UTC by a second session, before any change: `public`, `auth` and `storage` (58 tables, 3,024 rows), restore-checked (all 58 counts equal), handed to the owner as `deploi-prod-backup-2026-10-30.tar.gz` |
| Migration 035 | `20261030000035_role_switch_grants.sql` (from PR #6, renumbered past the agent library) applied at ~15:40 UTC with `launch-migrations.ts dry-run`, then `apply --http=<ref>`, on production (ledger 20 to 21) and deploi-preview (25 to 26). A no-op on Supabase, where `postgres` can already switch into anon/authenticated/service_role (checked first); recorded so the ledgers match the code. Row counts unchanged |

## TODO: drop the archive after 2026-11-29

The archived care tables stay in schema `archive` for 30 days. On or after **2026-11-29**, if nothing needed them:

    npx tsx scripts/archive-care-tables.ts drop --db <url> --confirm-production=makqaqzlylhckijdbjzi --confirm-drop

`drop` refuses before 30 days. Without a direct database connection, run the same `drop schema archive cascade`
through the Management API after checking `archive._archive_log`.

## Undo

- Code: promote `dpl_Dxe8DZQBkx3rUo4NqkjAV7cNnUbS` (the last pre-launch production deployment).
- Archive: `archive-care-tables.ts restore` (moves tables and functions back and re-issues their grants).
- Launch migrations: `supabase/rollback/` in reverse order, in one transaction (what `launch-migrations.ts rollback` runs; over HTTPS:
  `launch-migrations.ts rollback --http=makqaqzlylhckijdbjzi --confirm-production=makqaqzlylhckijdbjzi`, which refuses while the new tables hold rows).
  From a cloud session, Node needs `NODE_USE_ENV_PROXY=1` so its requests go through the proxy that adds the Management API token.
