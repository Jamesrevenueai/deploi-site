# deploi-app

The Deploi agent platform for online store owners: agents that find stock and listing problems in a
store and correct them only within the permissions the owner grants, plus competitor monitoring, agent
email addresses, tasks, a work log and a weekly summary. Next.js 15 (App Router), TypeScript strict,
Tailwind, Postgres with row-level security (Supabase in production). Shopify is the operational
platform; WooCommerce and Amazon are planned.

## Run locally

```bash
cp .env.example .env.local          # DATABASE_URL points at a local Postgres
npm install
npm run db:migrate                  # applies supabase/migrations (+ a local auth shim off-Supabase)
npm run seed                        # idempotent: staff logins and two synthetic merchants with synthetic stores
npm run dev                         # http://localhost:3000 -> /login (dev auth: pick a seeded user)
```

Sign in as `owner@northwind-goods.example` for the merchant area (`/store`), or `hello@getdeploi.com`
for staff (`/staff`: early access applications, store access and the audit log). For a fuller demo, run
`npx tsx --env-file=.env.local scripts/seed-platform-demo.ts` (and `--remove` to undo it).

## Checks

```bash
npm run typecheck && npm run lint && npm run test   # vitest, includes the RLS suite against DATABASE_URL
npm run build && npm run test:e2e                    # Playwright against the production build
```

## Safety

- Every table has RLS: a merchant sees only its own organization, staff see all. Enforced in
  Postgres; the app queries as the signed-in user (`lib/db.ts#withUser`) and writes through
  server functions after an explicit check.
- Every change an agent makes is bound to the authorization version it ran under, re-read before
  writing and confirmed by a fresh read. See `docs/HOW-AGENTS-WORK.md`.
- Inserts, updates and deletes are audited by trigger; the engine keeps its own audit trail
  (`engine_audit`), shown per agent as the work log. Read-only viewer at `/staff/audit`.
- Outbound network calls go through `lib/net/outbound.ts`: each purpose has an approved host list.
- `lib/log.ts` redacts person-identifying keys before anything is written to logs.
- Production refuses development sign-in at build, at start-up and at runtime
  (`lib/auth-guard.ts`, `docs/PRODUCTION-SAFETY.md`).

## Layout

- `app/store/*` merchant area, `app/shopify/*` the embedded Shopify app, `app/staff/*` staff area,
  `app/api/*` merchant API, Shopify and email webhooks, scheduled jobs, the early access form.
- `lib/engine` scans, proposals and verified writes; `lib/agents` policies, runs, tasks, work log,
  weekly summary; `lib/connectors` platform connectors; `lib/email` agent mailboxes;
  `lib/competitors` the Competitor & Trend Watcher.
- `supabase/migrations/` schema; `scripts/` migrate, seed, launch migrations, screenshots.
- `docs/` how agents work, launch steps, setup guides and checklists.
