# Production runbook, 2026-10-30

> **Status (2026-10-30, 15:30 UTC): executed, superseded. Do not run Phases A, B or D again.** The cloud session reached production through
> the Supabase Management API (HTTPS) instead of these `psql`/`pg_dump` scripts. What was done, in order, with evidence and rollback, is in
> `docs/PRODUCTION-LAUNCH-2026-10-30.md` on `main`. Facts as checked then on `makqaqzlylhckijdbjzi`:
> - Phase A: a full logical backup was taken at ~14:45 UTC, before any change (58 tables, 3,024 rows, restore check equal), and handed to the owner.
>   All care data was the synthetic seed of 2026-10-20 (Buckeye Home Care / Scioto Valley, `*.example` addresses).
> - Phase B: launch migrations 028-034 recorded at 14:57 UTC (ledger 12 -> 20).
> - Phase D: 15 care tables (622 rows) and `public_create_lead` moved to schema `archive` at 15:11 UTC; anon/authenticated have no access.
>   The 30-day drop TODO stands (`docs/ARCHIVE-CARE-TABLES.md`).
> - For a gated HTTPS route on any later run: `launch-migrations.ts --http=<ref>` and `archive-care-tables.ts --http <ref>` (dry run, apply,
>   rollback that refuses while new tables hold rows; archive dump/apply/verify/restore).
>
> The rest of this file is kept as written before the run.

Approved by the owner on 2026-10-30: steps 0 to 5 of `PRODUCTION-MIGRATION-PLAN.md`, plus PRs #4 and #6, in the order below.
**Stop at the first gate that fails.** Roll back only what that phase changed. Competitor Watcher: #3's engine wins.

## Why some steps are run by you

The cloud session cannot open a Postgres connection. Its network proxy carries HTTPS only (raw database ports 5432/6543 time out, and
`db.<ref>.supabase.co` does not resolve), and `PROD_DATABASE_URL` is not visible inside the session that started before it was added.
Supabase's HTTPS management API *is* reachable (`api.supabase.com` answers 401 without a token), which is a second route (see the end).

Every command below prints **one block to paste back**. None prints a database URL. Run them from a checkout of this branch:

```bash
git clone -b subscription-product https://github.com/Jamesrevenueai/deploi-site.git && cd deploi-site/deploi-app
npm ci --no-audit --no-fund
export PROD_DATABASE_URL='postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'   # Supabase -> Connect
```
Needs `psql`, `pg_dump` (PostgreSQL 15 or newer client tools) and Node 20+. The scripts switch port 6543 to 5432 themselves, because
`pg_dump` needs the session pooler. The project ref is `makqaqzlylhckijdbjzi`.

## PHASE A: safety first

| # | What | Command | Gate |
|---|---|---|---|
| 1 | Step 0, read-only inventory: migration ledger, row count of every table, care-table dates, seeded-or-real evidence, anonymous functions | `bash scripts/prod/phase-a.sh ./phase-a-$(date -u +%F) [scratch-db-url]` | ran without error |
| 2 | Step 1, backup: full `pg_dump`, every table's row count, ledger, sha256, restore into a scratch database and compare | (same command; give it an empty local database as the second argument, e.g. `createdb restore_check && ... postgres://localhost/restore_check`) | "restore check: OK" |
| 3 | Split Preview from the production database | see below | Production and Preview show different hosts |
| 4 | Fallback staff sign-in address | see below | you confirm you received the test link |

Paste `phase-a-<date>/PASTE-THIS.txt`. Keep `deploi-<stamp>.dump` and its `.sha256` on your own disk or private storage: it is the backup.
It holds production data, so do not commit or email it.

### 3. Split Preview from Production (Vercel project `deploi-app`)

Today `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` apply to **both**
Production and Preview, so Preview deployments use the production database and the production Supabase Auth.

1. Supabase dashboard -> New project: name `deploi-preview`, free plan, same region as production, a new database password.
2. Connect -> copy the session pooler URI (port 5432), the project URL, the anon key and the service-role key.
3. Vercel -> deploi-app -> Settings -> Environment Variables. For each of the four names above: edit the existing entry and untick
   **Preview** (leave Production ticked), then add a new entry with the same name for **Preview only** holding the `deploi-preview` value.
4. Build the preview schema and synthetic data (this never touches production):
   ```bash
   DATABASE_URL='<deploi-preview session URI>' NEXT_PUBLIC_SUPABASE_URL='<preview url>' SUPABASE_SERVICE_ROLE_KEY='<preview service key>' \
     npm run db:migrate && npm run seed
   ```
   `db:migrate` skips the retired consulting migrations 022 to 027. `seed` creates only synthetic merchants and the two staff logins.
5. Gate: in Vercel, the Production and Preview values of `NEXT_PUBLIC_SUPABASE_URL` name different hosts (the other three are hidden).

### 4. Fallback staff address (so staff sign-in does not depend on getdeploi.com mail)

`getdeploi.com` has no MX record (reported by PR #4, not re-checked from the cloud session), so `hello@getdeploi.com` cannot receive a
sign-in link. Add one address you can read, written here as `<you>`:

1. Vercel -> deploi-app -> Environment Variables -> **Production** `STAFF_EMAILS`: `hello@getdeploi.com,<you>` (the app reads it when it
   creates a profile at first sign-in).
2. Database (read by the sign-up trigger): `psql "$PROD_DATABASE_URL" -c "alter database postgres set app.staff_emails = 'hello@getdeploi.com,<you>';"`
3. If `<you>` already signed in once and has a `client` profile, promote it:
   `psql "$PROD_DATABASE_URL" -c "update profiles set role = 'staff', agency_id = null where lower(email) = lower('<you>');"`
4. Gate: open `https://app.getdeploi.com/login`, request a sign-in link for `<you>`, and confirm it arrives. **Do not continue to Phase C until it does.**

## PHASE B: production database (step 2)

```bash
bash scripts/prod/phase-b.sh makqaqzlylhckijdbjzi ./phase-b-$(date -u +%F)
```
Runs `status`, a one-transaction dry run, `apply`, then checks the gates: **7 of 7** launch migrations recorded, **32 of 32** new tables present,
`agencies`/`profiles`/`prospects` rows unchanged, care-table rows unchanged, the early access function and its five `prospects` columns present.
Any FAIL stops the script and runs the rollback (which refuses if the new tables already hold rows). Paste `PASTE-THIS.txt`.

Manual rollback, if needed later: `npx tsx scripts/launch-migrations.ts rollback --db "$PROD_DATABASE_URL" --confirm-production=makqaqzlylhckijdbjzi [--discard-data]`.

## PHASE C: ship (code; done by the assistant)

6. PR #4: bring up to date with `subscription-product` by merging (no history rewrite on a branch another session owns); drop its competing
   Competitor Watcher and its migration 33; keep the rest that is not consulting; full checks; merge.
7. PR #6: resolve the code conflicts (`install.ts`, `nav.ts`, `outbound.ts`, `e2e/security.spec.ts`, `shopify.app.toml.example`); keep the newer
   docs and screenshots; full checks; merge.
8. Step 3: merge PR #1 (`subscription-product` -> `main`) on a SHA whose full checks are green. Production reaches READY on `app.getdeploi.com`
   and `getdeploi.com`.
9. Step 4: smoke tests and 15 minutes of logs: sign-in works with no dev picker; `AUTH_MODE` absent on Production; only `/api/cron/agents` and
   `/api/cron/weekly-summary` exist; no consulting cron fires at the next top of the hour. **Any failure: roll back to
   `dpl_Dxe8DZQBkx3rUo4NqkjAV7cNnUbS` first, then run the migration rollback.**

## PHASE D: cleanup

```bash
bash scripts/prod/phase-d.sh makqaqzlylhckijdbjzi ./phase-d-$(date -u +%F)
```
10. Step 5: `report` (refuses on blockers), `dump` of the care tables, `apply` in one transaction, `verify` (row counts equal, `anon`/`authenticated`/
    `service_role` denied). Paste `PASTE-THIS.txt`; keep `care-tables.dump`. The 30-day drop TODO stays (`docs/ARCHIVE-CARE-TABLES.md`).
11. Rotate `APP_SECRET` on Production (Vercel -> Production only), redeploy, and confirm an old session cookie is refused.

## Second route: HTTPS instead of running commands

If you would rather not run commands, add a Supabase personal access token as the environment secret `SUPABASE_ACCESS_TOKEN`
(Supabase -> Account -> Access tokens; revoke it afterwards). `scripts/supabase-http.ts` already runs SQL through the management API.
The inventory and the migrations are plain SQL and would work that way. A `pg_dump` cannot: that route would produce a logical export
(rows as JSON plus the schema from the migrations), not a `pg_dump`. It would also need a session started after the secret exists. Say so and it gets built and rehearsed first.

## Rehearsal evidence (local copies, synthetic data)

| Script | Result |
|---|---|
| `phase-a.sh` | inventory ok; dump 156,764 bytes; restore check OK, 30 of 30 public tables equal |
| `phase-b.sh` | ledger 7 of 7; 32 of 32 new tables; kept rows 1/0/0 unchanged; care rows 40 unchanged; RESULT: PASS |
| `phase-d.sh` | 22 tables (40 rows) and 2 functions archived; verify ok; RESULT: PASS |
