# Backups and restore

Deploi's data lives in one Supabase Postgres database. This page says what the Supabase plan gives us, how to
restore into a new project, the targets we hold ourselves to, and how the restore is rehearsed.

## What the Supabase plan includes

| Plan | Daily backups | Point-in-time recovery (PITR) | Notes |
|---|---|---|---|
| Free | none you can restore | no | not acceptable for customer data |
| Pro | daily, kept 7 days | add-on (7, 14 or 28 days of WAL) | the minimum for launch |
| Team | daily, kept 14 days | add-on | |
| Enterprise | daily, kept up to 30 days | add-on | |

Figures as published by Supabase when this was written; check the current plan page before relying on them.
Daily backups are physical snapshots taken by Supabase; restoring one replaces the project's database with the
state at that snapshot. PITR restores to any second within its window. Storage buckets are **not** part of the
database backups (Deploi stores no customer files in Storage today).

**Owner action (not configured from this repository):** confirm the production project is on Pro or higher and
enable the PITR add-on (7 days is enough for the RPO below). Check under Project Settings -> Add-ons.

## Targets

| | Target | How |
|---|---|---|
| RPO (data we can lose) | 5 minutes with PITR; 24 hours without | PITR add-on; daily backup otherwise |
| RTO (time to serve again) | 2 hours | restore into a new project (below) and repoint Vercel |

The rehearsal below measures the database part of the RTO (dump + restore + checks): about 5 seconds for the
test database (108 tables, ~18k rows); production should be timed the same way on a copy before launch.

## Restore into a new project

Restoring in place overwrites production; restore into a **new** project when the old one must be kept for
investigation (the usual case after a bad migration or a data incident).

1. Supabase dashboard -> the production project -> Database -> Backups. Choose the daily backup or (PITR) the
   time just before the incident. Use "Restore to new project" where offered; otherwise create a new project in
   the same region and restore with `pg_restore` from a dump (step 3).
2. Without a restore-to-new-project button: download the backup (or take `pg_dump -Fc` of the old project
   through its direct connection string, never the pooler) and keep it off any shared drive.
3. `pg_restore --exit-on-error -d "<new project direct URL>" db.dump`. Supabase's own roles (`authenticated`,
   `service_role`, `anon`) exist in every project, so policies and grants restore unchanged.
4. Verify the copy before serving it, with the same checks as the rehearsal: row counts per table against the
   source, RLS on for every table with the same policies, and `select * from verify_engine_audit_chain(<org>)`
   true for every organization (the tamper-evident audit trail survives the copy).
5. Point the app at it: in Vercel set `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   and `SUPABASE_SERVICE_ROLE_KEY` to the new project's values; redeploy. Set `JOBS_PAUSED=on` first so no job
   runs against a half-checked copy, then turn it off.
6. Auth: users (`auth.users`) are in the database and restore with it; re-add the redirect URLs and the SMTP
   settings in the new project's Auth settings (they are project settings, not data).
7. Webhooks: Shopify, WooCommerce, Stripe and the agent-mail provider post to the app's URL, not the database,
   so nothing changes there. Events that arrived between the restore point and the cut-over are replayed by the
   providers' retries (Stripe up to 3 days; Shopify 48 hours) and processed idempotently.

## Rehearsal

`bash scripts/restore-rehearsal.sh [SOURCE_URL]` (default: the test database in `.env.test`). It:

1. dumps the source (`pg_dump -Fc`), reporting size and time;
2. restores into a fresh local database, reporting time;
3. compares the row count of every public table between source and copy;
4. compares RLS flags and policy lists for every table, then signs in as an organization that does not exist and
   checks it reads 0 rows from every org-scoped table, and that the anonymous role reads no applicants;
5. runs `verify_engine_audit_chain` for every organization's chain in the copy (and checks the source's chain).

It exits 0 only when every check passed, drops the copy afterwards, and refuses a Supabase source unless
`--confirm-production` is given (it then only reads the source; the copy is always local). The test suite runs
it on every full run (`tests/platform/restore-rehearsal.test.ts`). Last run (2026-11-05, test database): passed,
108 tables, 18,370 rows, 10 audit chains / 3,717 rows verified, restore 3.8 s.

**Owner action:** run it once against a production copy (`--confirm-production`, from a trusted machine) before
launch and after any large migration, and record the restore time here.
