# Working rules for the operations-service build (read before changing anything)

Repository: `/home/user/deploi-site` is the marketing site (Vite/React, Black Glass). `/home/user/deploi-site/deploi-app`
is the Next.js 15 App Router application (TypeScript strict, Tailwind v4, Postgres with RLS). Read `deploi-app/README.md`,
`deploi-app/docs/CURRENT-STATE.md`, `deploi-app/docs/CONTRIBUTING-SECTIONS.md`, and `deploi-app/lib/catalog/*` first.

## Hard rules (every stream)

- Never reference, import, link or mention the previous companies or repositories named in the master brief's hard rules (the integrator greps for them before every commit with `scripts/forbidden-grep.sh`; run it before you finish).
- Never send real communications, charge anyone, contact anyone, deploy, or touch production data. Adapters stay mocked.
  Never enable auto-send by default. Every "send" in tests must land in `mockOutbox` / `mockSmsOutbox` with `mocked: true`.
- Synthetic data only, in seeds, fixtures, tests and screenshots. Never store a password in a form, note, log or table.
- No PHI in logs: use `lib/log.ts` (`log.info(msg, { ids, counts })`), never names, phones, emails, message bodies.
- Every new table: `agency_id` where it is tenant data, `enable row level security`, the same policy shape as
  `20261020000001_foundation.sql` (`is_staff() or agency_id = current_agency_id()`; staff-only tables use `is_staff()`),
  `grant all on <table> to authenticated, service_role`, and an `audit_row()` trigger (tables with a non-uuid primary key need
  their own audit trigger, see `0013_settings.sql`). Internal rates and margins must be unreadable by clients both in RLS and in UI.
- Pages and server actions run as the signed-in user: `requireRole('staff' | 'client')` then `withUser(session, db => …, { ip })`.
  `admin()` is only for workers, webhooks, crons and auth bootstrap. Audit reads of client data with `db.auditRead(table, agencyId, ids)`.
- Keep existing routes, features, design conventions and tests working. Do not rewrite; extend.
- Do not commit. The integrator commits per phase. Do not run `git add`/`git commit`/`git stash`.
- Do not edit these shared files; report what you need instead: `lib/nav.ts` (give the nav entries you want),
  `lib/env.ts` (read `process.env` through a small getter in your own module and report the variable names), `README.md`,
  `package.json` (ask before adding a dependency), `scripts/seed.ts` (add `scripts/seed-parts/<area>.ts` exporting
  `seedArea(ctx)` and register it with one line in `scripts/seed-parts/index.ts`).
- If `next dev` rewrites `tsconfig.json`, run `git checkout -- tsconfig.json`. Kill only your own dev server
  (`ps -eo pid,args | grep "[n]ext dev -p <your port>"`), never `pkill node`.

## Conventions

- Server components, `export const dynamic = 'force-dynamic'`, `metadata = { title }`; UI primitives from `components/ui`
  (`PageHeader`, `Tile`, `Badge`, `Banner`, `Empty`, `Field/Input/Select/Textarea`, `Button`, `Sheet`, `ImageCard`);
  class names from `styles/*.css` (`btn`, `btn ghost sm`, `badge`, `badge muted|ok|warn|danger`, `banner`, `glass`, `metal`,
  `rounded-[20px] border border-line p-5`). Server actions in a sibling `actions.ts` with `'use server'`, redirecting with
  query flags (`?saved=1`, `?error=…`) that the page shows as a `Banner`.
- Every page needs an empty state, an error/blocked state and must read at 390 px and 1440 px.
- Simulated things are labelled simulated everywhere (badge `simulated` on cards, a column in exports, a line in reports).
- Tests: vitest, `tests/<area>/*.test.ts`, with `tests/<area>/env.ts` that starts with
  `if (process.env.<AREA>_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.<AREA>_TEST_DATABASE_URL` and is imported
  first. `prepareDb()` from `tests/db/helpers.ts` migrates + seeds. Tests must be idempotent against the seed (reset what you mutate).
  Run your suite alone: `<AREA>_TEST_DATABASE_URL=<local url with your db name> npx vitest run tests/<area>`. The local URL is
  the `DATABASE_URL` in `deploi-app/.env.local` with the database name swapped.
- Migrations: `supabase/migrations/20261021<NNNNNN>_<name>.sql`, additive only, idempotent (`if not exists`, `drop policy if exists`).
  Use only the numbers assigned to your stream.

## Stream ownership (do not edit another stream's files; ask the integrator)

| Stream | Owns | Migrations | Test DB | Dev port |
|---|---|---|---|---|
| site | `/home/user/deploi-site/src/**`, `scripts-for-site`, `src/data/catalog.json` (generated) | none | none | 5174 |
| assess | `lib/leaks.ts`, `lib/leaks.test.ts`, `lib/assessments/**`, `lib/credit/**`, `lib/report/pdf.tsx`, `components/assessments/**`, `app/staff/assessments/**`, `app/staff/agencies/[id]/**`, `tests/assessments`, `tests/credit` | `20261021000018` (0017 credit ledger already exists: extend `lib/credit/ledger.ts`, do not re-create) | `deploi_test_b` | 3101 |
| engage | `lib/engagements/**`, `lib/proposals/**`, `lib/pilots/**`, `lib/onboarding/**`, `lib/report/proposal-pdf.tsx`, `app/staff/engagements/**`, `app/staff/pilots/**`, `components/engagements/**`, `tests/engagements`, `tests/pilots`, `tests/onboarding` | `…019`, `…020`, `…021` | `deploi_test_c` | 3102 |
| ops | `lib/workers/**`, `workers/**`, `lib/consent/**`, `lib/evv/**`, `lib/imports/**`, `lib/jobs/**`, `app/api/webhooks/**`, `app/api/cron/**`, `app/api/evv/**`, `app/staff/actions/**`, `app/staff/evv/**`, `components/actions/**`, `components/evv/**`, `tests/workers`, `tests/evv`, `tests/consent`, `tests/imports`, `tests/jobs`, `docs/evv-connectors.md` | `…023`, `…024` (0022 job_runs + `lib/jobs/lock.ts` already exist: use them) | `deploi_test_d` | 3103 |
| econ | `lib/economics/**`, `lib/queue/**`, `lib/dashboard/**`, `emails/**`, `app/staff/economics/**`, `app/staff/queue/**`, `app/app/**` (client area pages), `app/staff/emails/**`, `components/dashboard/**`, `components/economics/**`, `tests/economics`, `tests/queue`, `tests/dashboard` | `…025`, `…026` | `deploi_test_e` | 3104 |
| web | `lib/website/**`, `app/staff/website/**`, `components/website/**`, `app/api/public/lead/route.ts`, `lib/sales/**`, `components/sales/**`, `app/staff/pipeline/**`, `tests/website`, `tests/api`, `tests/sales` | `…027` | `deploi_test_f` | 3105 |

Shared read-only inputs: `lib/catalog/*` (service catalog, pricing, integrations). If you need a catalog change, report it.

## Cross-stream contracts

**Lead API (web implements, site consumes).** `POST /api/public/lead` keeps every existing field and accepts, optionally:
`service_interest: 'operations' | 'website_improvement'`, `website_url`, `website_platform`, `website_goal`,
`website_pages: string[]` (max 3), `website_changes`, `website_issues`,
`access_status: 'have_login' | 'need_to_find' | 'agency_managed' | 'unknown'`. Unknown fields are ignored. A website lead
creates a prospect with `service_interest = 'website_improvement'`, tag `Website Improvement`, `website_url`, `website_goal`,
plus a `website_engagements` row in status `inquiry`.

**Website engagement tables (web creates, econ reads).**
`website_engagements(id uuid pk, prospect_id uuid, agency_id uuid null, status text, website_url text, platform text, goal text,
pages jsonb, requested_changes text, known_issues text, access_status text, approval_contact text, price_cents int default 50000,
payment_status text default 'unpaid' /* unpaid | mock_paid | paid */, payment_is_mock boolean default true, paid_at timestamptz,
target_date date, created_at, updated_at)` and
`website_labor(id uuid pk, website_engagement_id uuid fk, hours numeric(6,2), kind text /* review|implementation|testing|revision|handoff */,
note text, logged_by uuid, logged_at timestamptz default now())`. Both staff-only in RLS.

**Engagement tables (engage creates, econ and assess read).**
`engagements(id uuid pk, agency_id uuid fk, prospect_id uuid, assessment_id uuid null, service_key text, status text, setup_fee_cents int,
monthly_fee_cents int, credit_applied_cents int default 0, …)`. Status values: draft, proposed, accepted, building, testing, pilot,
active, paused, completed. `pilots(id, engagement_id, agency_id, starts_on, ends_on, primary_metric_key, decision text null, …)`.

**Action states (ops owns).** `proposed_actions.status`: proposed (= drafted) → approved → queued → attempted → delivered | failed | unknown,
plus skipped, expired, suppressed. `proposed_actions.simulated boolean` is true when the adapter mocked the send. Nothing else may
mark a proposed action delivered.

**Credit ledger (assess owns).** `assessment_credits(id, agency_id, assessment_id, original_fee_cents, payment_status, eligible_service_key,
expires_at, credit_cents, applied_cents, remaining_cents, …)` + `assessment_credit_applications(id, credit_id, engagement_id, amount_cents, applied_by, applied_at)`.
Engage calls `applyCredit(db, creditId, engagementId, amountCents, actorId)` from `lib/credit/ledger.ts`; it must refuse a second
application for the same engagement and never exceed remaining.

**Job locks (ops owns).** `lib/jobs/lock.ts#withJobLock(db, key, periodKey, fn)` guarantees one execution per key per period;
econ's morning-report sender and ops' crons both go through it.

## Deliverable from each stream

A written summary: what you built, routes and files, migrations, tests run with the real results (paste the vitest summary line),
what is simulated, what is blocked, nav entries wanted, env var names wanted (no values), and anything the integrator must wire.
