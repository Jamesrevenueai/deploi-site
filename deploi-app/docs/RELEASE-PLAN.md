# Release plan: merge order, migrations, environment, deployment and smoke tests

Prepared 2026-10-29. Nothing here has been done to production; every step marked **Owner** needs your
explicit approval at the time. Merging into `main` deploys production on Vercel.

## 1. What is in which PR (verified on GitHub, 2026-10-29)

| PR | Branch → base | Contains | State |
|---|---|---|---|
| #2 | `claude/prod-auth-guard` → `main` | Production refuses dev auth (build, start, runtime); per-project `ignoreCommand` | Draft |
| #1 | `subscription-product` → `main` | Merchant engine, four Shopify corrections, named agents, email connector (migrations 28–31) | Draft |
| #3 | `claude/agents-platform` → `subscription-product` | Permission tiers, three templates, tasks, work log, weekly summary, agent mailboxes (migration 32); a cherry-pick of #2's code | Draft, head `b5cadff` |
| new | `claude/platform-launch` → `claude/agents-platform` | This release: security fixes, Competitor & Trend Watcher (migration 33), store eligibility (migration 34), entitlements, docs. **#2 is merged into it with conflicts resolved.** | Draft |

`main` (`b8aad24`) already contains code that needs migrations 28–29. Production runs the rolled-back
`fd0e89e`. So **any** merge into `main` deploys code that needs migrations applied first.

## 2. Merge order (updated)

The proposed order #2 → #1 → #3 still works, with two changes: **apply the migrations before the first
merge**, and **merge the new PR into #3 before #3 moves**, so that production is deployed twice at most.

0. **Owner, first and independent of any merge:** close the dev sign-in (`PRODUCTION-SAFETY.md` §2, steps
   1–6). This needs no code and no migration.
1. **Owner:** back up production and apply migrations 28–34 (section 3). They are additive: no table, column
   or row is removed, and the running `fd0e89e` code does not read the new tables.
2. Merge **#2 → `main`**. Production deploys `main` + the guard. If `AUTH_MODE`/`ALLOW_DEV_LOGIN` are still
   on Production, the build fails and production stays as it is (safe). Run the smoke tests (section 6, A).
3. Merge **new PR → `claude/agents-platform`** (preview deploy only).
4. Merge **#3 → `subscription-product`** (preview deploy only).
5. Merge **`main` into `subscription-product`** if GitHub asks (I checked: `main` + #2 + this branch merges
   with **0 conflicts**), then merge **#1 → `main`**. Production deploys the whole platform. Run the smoke
   tests (section 6, A and B).

Alternative with one production deploy of new code: skip step 2 and let step 5 carry the guard (it is in this
branch). Step 2 is still recommended because it is small and makes a misconfigured production build fail.

## 3. Migrations 28–34: backup, apply, rollback

Files: `supabase/migrations/20261028000028_merchant_engine.sql` … `20261029000034_store_eligibility.sql`;
rollbacks in `supabase/rollback/*.down.sql`. Runner: `scripts/launch-migrations.ts` (refuses a Supabase host
unless `--confirm-production=<project-ref>` names it; never reads the target from the environment).

Tested on a copy shaped like production today (`bash scripts/test-launch-migrations.sh`, 2026-10-29):
apply all seven, app tests pass on the migrated copy (42), rollback refuses while launch tables hold data,
rollback with `--discard-data` restores an **identical schema** with the original rows, re-apply works.
`ALL LAUNCH MIGRATION CHECKS PASSED`.

**Owner steps:**

1. **Backup.** Supabase → Database → Backups: confirm today's daily backup exists, or on a plan with PITR note
   the time. Also take a logical dump you hold yourself:
   `pg_dump "$SUPABASE_DIRECT_URL" --no-owner -Fc -f deploi-prod-2026-10-29.dump` (direct host, port 5432).
2. **Status:** `npx tsx scripts/launch-migrations.ts status --db "$SUPABASE_DIRECT_URL" --confirm-production=makqaqzlylhckijdbjzi`
   (expects 027 applied, 028–034 not applied).
3. **Dry run** (one transaction, rolled back): same command with `dry-run`.
4. **Apply:** same command with `apply`. Each file is its own transaction and is recorded in `_migrations`.
5. **Rollback, only if needed:** `rollback` (refuses while new tables hold data; `--discard-data` to force).
   Rolling back after merchants have used the platform discards their agents and history; restoring from
   the dump in step 1 is the other route.

## 4. Environment variables (Vercel → `deploi-app` → Production). Names only, never values.

Already set (verified 2026-10-29): `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `STAFF_EMAILS`, `PUBLIC_API_ALLOWED_ORIGINS`, `CRON_SECRET`,
`APP_SECRET` (rotate: `PRODUCTION-SAFETY.md`). **Remove from Production:** `AUTH_MODE`, `ALLOW_DEV_LOGIN`.

Needed for the platform (not set today):

| Variable | Purpose | Where it comes from |
|---|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | App Bridge session tokens, OAuth, webhook HMAC | Shopify Dev Dashboard → the app |
| `SHOPIFY_APP_URL` | `https://app.getdeploi.com` | fixed |
| `SHOPIFY_API_VERSION` | defaults to `2026-10`; set only to pin | fixed |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID` | encrypts store tokens and email content (AES-GCM) | `openssl rand -base64 32`; id e.g. `prod-k1` |
| `RESEND_API_KEY` | agent mailboxes and the weekly summary | Resend → API Keys (`LAUNCH-STEPS.md` step 2) |
| `AGENT_MAIL_DOMAIN` | `agents.getdeploi.com` | after Resend verifies the domain |
| `AGENT_MAIL_WEBHOOK_SECRET` | verifies inbound agent mail | Resend → Webhooks → signing secret |
| `RESEND_WEBHOOK_SECRET` | verifies delivery events and referral inbound | Resend → Webhooks |
| `EMAIL_LIVE_SENDS` | `off` until the email test passes, then `allowlist` | owner decision |
| `EMAIL_TEST_RECIPIENTS` | the owner-designated test mailbox (with `allowlist`) | owner |
| `LLM_MOCK` | `1` unless a private Ollama host exists (task drafting is deterministic either way) | fixed |
| `PLAN_KEY`, `PLAN_MAX_AGENTS`, `PLAN_MAX_COMPETITOR_STORES`, `PLAN_MAX_COMPETITOR_REQUESTS` | free-beta limits (defaults: beta_free, 10, 25, 20) | optional |
| `COMPETITOR_REQUEST_DELAY_MS` | pause between requests to one store (default 1000) | optional |

Do **not** set in Production: `AUTH_MODE`, `ALLOW_DEV_LOGIN`, `DEMO_CONTROLS`, `LIVE_WRITES=all`,
`PUBLIC_FETCH_PROXY`, `PAYMENTS_LIVE`, `BILLING_REQUIRED=true` (no plan exists). Write access for real stores
is granted per shop in the `store_eligibility` table (section 5), not by environment.

## 5. Store eligibility (replaces the named-store restriction)

Any shop can install and use every read-only feature (Shopify review requires installability). Writes to a
real store need a row, granted by Deploi staff with the service role (Supabase → SQL editor):

```sql
-- an approved beta merchant
insert into store_eligibility (shop, tier, live_writes, granted_by, note) values ('their-store.myshopify.com', 'beta', true, 'staff:<you>', 'beta cohort 1');
-- a Shopify app-review or partner development store: must end
insert into store_eligibility (shop, tier, live_writes, granted_by, expires_at) values ('<review-store>.myshopify.com', 'review', true, 'staff:<you>', now() + interval '30 days');
-- refuse a shop entirely (cannot install, never written to)
insert into store_eligibility (shop, tier, live_writes, granted_by) values ('<shop>.myshopify.com', 'blocked', false, 'staff:<you>');
```

The merchant sees "Changes cannot be written to this store yet" before granting or approving anything, and
an approved change to an ineligible store is refused before any request with that reason. For Shopify review
stores, whose names are not known in advance: grant the row after the reviewer installs (their shop appears in
`select external_id, installed_at from store_connections order by installed_at desc`), or point the reviewer at
the steps that need no writes (drafts only and the Competitor & Trend Watcher).

## 6. Post-deployment smoke tests

A. After any production deploy (read only, no data created):

1. `node scripts/verify-production-login.mjs https://app.getdeploi.com` → `… passed, 0 failed`.
2. `curl -s https://app.getdeploi.com/api/health` → `"auth":"supabase"`.
3. `curl -s -o /dev/null -w '%{http_code}' https://app.getdeploi.com/api/cron/agents` → `401`.
4. Sign in by emailed link as staff; `/staff/pipeline` loads.

B. After the platform deploy (needs the owner's development store, `DEV-STORE-CHECKLIST.md`):

5. Install on the development store; Overview says Connected; write eligibility shows "not enabled yet"
   until you add its `store_eligibility` row.
6. Create an Inventory Watcher (drafts only), Run now, see drafted changes, store unchanged.
7. Create a Competitor & Trend Watcher with one public Shopify store you are allowed to monitor; Run now; the
   store shows "Readable" and a baseline; nothing is reported as new.
8. Uninstall from the development store; the store shows disconnected and its agents paused.

## 7. Rollback of a deployment

Vercel → `deploi-app` → Deployments → the previous production deployment → **Instant Rollback**. The
migrations are additive, so the previous code runs on the migrated database. Remember that an Instant
Rollback pauses automatic domain assignment until you promote a deployment again.
