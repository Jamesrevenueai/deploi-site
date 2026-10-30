# Production database plan: launch migrations and the care-table archive

**Not approved. Nothing here has been run against production.** The build session has no production database credentials, so every
number about production below comes from its Vercel runtime logs and environment settings, not from the database. Step 0 replaces
those inferences with facts before anything changes.

## What production looks like today (observed 2026-10-29/30)

- Serving `dpl_Dxe8DZQBkx3rUo4NqkjAV7cNnUbS`, commit `fd0e89e`: the **consulting app**. `main` is `b8aad24`, which is not deployed.
- The database is **behind the consulting schema**. In the last 24 hours all 24 `morning-report` runs and the 06:00 `workers` run
  failed with `column "delivery_status" does not exist` (migration 023) or `relation "job_runs" does not exist` (migration 022).
  So it is at or below migration `20261021000021`. The three consulting crons still fire every hour or day but fail before they
  can send anything. They are being disabled in the Vercel dashboard.
- `AUTH_MODE` and `ALLOW_DEV_LOGIN` exist on **Preview only**; `APP_SECRET` was rotated; no dev picker has been used since.
- `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the rest are shared by **Production and Preview**: Preview deployments use the
  production database.
- None of the agent platform's settings exist on Production yet: no `SHOPIFY_*`, `CREDENTIALS_ENCRYPTION_KEY`/`_KEY_ID`, `RESEND_API_KEY`,
  `AGENT_MAIL_*`, `STORE_ACCESS_MODE`. The code fails closed without them (no store connects, no mail sends).

## What PR #1 changes (the step that deploys)

`main` -> `subscription-product`: **29 commits, 206 files, +14,481 / -370** (before PRs #3 and #5, which add the agent platform and
remove the consulting code on the same branch). Merging it into `main` **deploys Production**. In outline:

- the merchant engine, four Shopify corrections, agents, email connector, Shopify App Store readiness (store access, App Pricing check);
- website: agents section, `/support`, privacy policy;
- after #3/#5: permission tiers, templates, tasks, work log, weekly summary, agent mailboxes, Competitor & Trend Watcher; the care app,
  staff pipeline and consulting crons are removed. Staff land on early access applications, store access and the audit log; an account
  not linked to a store sees "No store is linked to this account".
- `vercel.json` crons become exactly `/api/cron/agents` (hourly) and `/api/cron/weekly-summary` (Mondays). They need `CRON_SECRET`, which exists.

## The order, and why

| # | Gate | What | Why this position |
|---|---|---|---|
| 0 | read only | `report` + inventory of `_migrations` and every table's row count (commands below) | replaces inference with facts; changes nothing |
| 1 | backup | full `pg_dump` + row counts + restore check | before any change |
| 2 | migrations | apply the 7 launch migrations with `launch-migrations.ts` | additive; the running consulting app does not read the new tables |
| 3 | deploy | merge PR #1 -> `main` | needs steps 1-2; **needs your explicit approval** |
| 4 | verify | smoke tests on Production, logs for 15 minutes, rollback to `dpl_Dxe8DZQ...` if anything breaks | |
| 5 | archive | dump the care tables, then `archive-care-tables.ts apply` | **after** step 3: until the new app is live, the old app still uses these tables |

Each gate stops the sequence on any failure and reports; none continues past a failed check.

## Step 2: the launch migrations, one by one

Nothing in 028-033 reads, writes or alters a care table (checked against the 34 names). All are additive except where noted.

| Migration | What it does | Tables | Alters existing | Reversible? |
|---|---|---|---|---|
| `20261028000028_merchant_engine` | Shopify store connections, rules, scans, issues, proposals, approvals, executions, audit, billing state | 12 new | `agencies` (+`org_type`); redefines the shared `audit_row()` trigger function (adds an `org_id` fallback; identical result for every older table) | Yes: drops the 12 tables, restores the old `audit_row()`, drops `org_type` |
| `20261028000029_early_access_leads` | `public_create_early_access()` for the website form | none | `prospects`: adds 5 columns + 2 indexes **if missing** (see note) | Yes: drops the function; drops the 5 columns only if consulting migration 027 is not recorded and they hold no data |
| `20261028000030_agents` | agents, policies, runs, reference files | 5 new | adds columns to `approvals`, `executions`, `issues`, `proposals`, `scans`, `store_connections` (all from 028) | Yes |
| `20261028000031_email` | email accounts, credentials, messages | 5 new | none | Yes |
| `20261028000032_agent_platform` | agent mailboxes inbound, tasks, weekly summaries | 4 new | `email_accounts`, `email_messages` (from 031) | Yes |
| `20261029000032_store_access` | beta eligibility and invites | 2 new | `store_connections` (+`shop_gid`) | Yes |
| `20261029000033_competitor_watch` | competitor sources, products, checks, findings | 4 new | none | Yes |

**Note, found while rehearsing.** The early access function (029) writes five `prospects` columns that were first added by
consulting migration 027. On a database behind 027, which is what Production's logs show, the form would have failed with a 500 even
after the migrations applied. Migration 029 now adds those columns itself (idempotent); its rollback was extended to match. The
launch script's prerequisite also dropped from 027 to `20261020000016`, because the launch migrations do not need the consulting
migrations 017-027 (tested for every cut-off from 001 to 027). Step 0 must confirm `20261020000016` is recorded.

**Rollback.** One transaction; it refuses to drop any table that holds rows, and leaves every migration in place when it refuses:

```bash
npx tsx scripts/launch-migrations.ts rollback --db "$PROD_URL" --confirm-production=makqaqzlylhckijdbjzi
# only after the step-1 backup, to discard rows the new tables have collected:
npx tsx scripts/launch-migrations.ts rollback --db "$PROD_URL" --confirm-production=makqaqzlylhckijdbjzi --discard-data
```

Rehearsed: `bash scripts/test-launch-migrations.sh` builds a copy at migration 021 plus care data and early access data, then: refuses the
production host without `--confirm-production`; dry-run changes nothing; apply keeps every existing row; 42 merchant and platform tests
pass on the migrated copy; a refused rollback leaves all 7 migrations recorded; a `--discard-data` rollback leaves a schema **identical**
to the original and the original rows intact; re-apply works.

## Step 1: the backup

```bash
bash scripts/backup-before-launch.sh "$PROD_URL" ./backup-$(date -u +%F) --verify-into "$SCRATCH_URL"
```

Writes a full custom-format `pg_dump`, the exact row count of every table, the migration ledger and a sha256, then restores the dump into
an empty scratch database and compares every public table's row count with the source. Emergency restore of everything:
`pg_restore --no-owner --clean --if-exists -d "$PROD_URL" <dump>` (destructive; only with your say-so). **Keep the files outside the
cloud session**: its disk is discarded when it ends. Rehearsed on the production-shaped copy: 320,854-byte dump, 62 public tables, restore
check equal.

## Does anything break the Shopify dev-store test or the `APP_SECRET` rotation?

- **`APP_SECRET`:** in the merged code it only signs dev-session cookies (`lib/auth.ts`). Production no longer has `AUTH_MODE=dev`, the build
  refuses to run with it (`lib/auth-guard.ts`), and no other code uses the secret. Webhook and install verification use `SHOPIFY_API_SECRET`,
  cron uses `CRON_SECRET`. The rotation is unaffected, and rotating again later has no side effect beyond Preview sessions.
- **Dev-store test (PR #6):** it adds no migration and does not touch the launch migrations. It changes `lib/auth.ts`, the cron routes, scopes
  and the uninstall handler, all on top of PR #5; a trial merge of #6 onto the merged branch is in the final report. Two things to know:
  Preview and Production share one database, so once step 2 runs, the dev-store install (`james-jwtftl1e.myshopify.com`) from a Preview
  deployment writes real `agencies` and `store_connections` rows into the **production** database; and before step 2 a Preview run of this
  code fails on missing tables. Giving Preview its own database (or its own Supabase branch) removes both.
- **Staff sign-in after step 3.** Dev sign-in is gone, so staff use Supabase email links. PR #4 recorded that `getdeploi.com` has no MX
  record, so `hello@getdeploi.com` (the only `STAFF_EMAILS` entry) cannot receive them. I could not check DNS from here. Fix the mailbox or
  add a second staff address **before** step 3 or staff cannot open `/staff`.

## What I need to run it

1. Your one-word approval. Suggested word: **approve**. It covers steps 0-2 and 4 on the stated conditions; steps 3 and 5 each still need
   their own "go" because 3 deploys Production and 5 removes the tables from the application's view.
2. Access: add `PROD_DATABASE_URL` as an environment secret in this environment's settings (the cloud environment menu, then Edit; a
   new session picks it up), never in chat. Use a role that can run DDL for steps 2 and 5; a read-only role is enough for step 0. The
   network policy must allow the Supabase database host on 5432 or 6543, or run the commands above from your machine and paste back the output.
3. A place outside the session to keep the backup and dump files.
4. A scratch Postgres for the restore check (a local one is fine).
