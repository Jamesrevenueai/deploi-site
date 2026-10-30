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

## Environment variables introduced by the Shopify and agent-platform work

All optional; empty means "off" or "synthetic". `.env.example` lists every name.

| Variable | What it does |
|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Client credentials of the Shopify app (Dev Dashboard). Without both, every `/api/shopify/*` route answers 503 and the embedded app says "open this app from your Shopify admin". Preview and local only until launch; never commit them. |
| `SHOPIFY_API_VERSION` | Admin GraphQL version, default `2026-10`. |
| `SHOPIFY_APP_URL` | Public URL of the app (the CLI tunnel during `shopify app dev`); falls back to `NEXT_PUBLIC_APP_URL`. |
| `SHOPIFY_APP_HANDLE` | App handle from the Dev Dashboard; used for the Shopify-hosted pricing page URL. |
| `SHOPIFY_SCOPES` | Scopes installed with the app. Default `read_products,read_inventory,read_locations` (read only); must equal `[access_scopes].scopes` in `shopify.app.toml`. |
| `SHOPIFY_OPTIONAL_SCOPES` | Scopes asked for at runtime when an agent is widened past drafts only. Default `write_products,read_publications,write_publications`; must equal `optional_scopes` in the TOML. |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID` | AES-256-GCM key (base64 of 32 random bytes) and its id for store and mailbox tokens at rest. |
| `LIVE_WRITES` | Writes to real stores are governed by store access (`lib/engine/access.ts`: open mode, a development store, a redeemed beta invite or staff approval). `LIVE_WRITES=off` pauses writes to every real store (incident switch). The old `LIVE_WRITE_STORES` allowlist is gone. |
| `BILLING_REQUIRED` | `true` makes corrections require an active Shopify subscription. Off during early access. |
| `RESEND_API_KEY` | Resend key for agent mail and the weekly summary. Empty: an in-process fake accepts sends and nothing leaves the machine. |
| `AGENT_MAIL_DOMAIN` | Domain for agent mailboxes (`<name>.<code>@<domain>`). Templates can give an agent its own address only when set; use `agents.getdeploi.test` locally. |
| `AGENT_MAIL_WEBHOOK_SECRET` | svix secret of the Resend `email.received` webhook; inbound mail is refused without it. |
| `EMAIL_LIVE_SENDS` | `off` (default): approved sends are held and marked failed with the reason. `allowlist`: only `EMAIL_TEST_RECIPIENTS` may receive. `all`: production, after review. |
| `EMAIL_TEST_RECIPIENTS` | Comma-separated addresses or `@domains` allowed under `allowlist`. |
| `EMAIL_OAUTH_PROVIDERS` | `on` shows the Gmail / Microsoft connectors (not live-verified). |
| `DEMO_CONTROLS` | `true` enables `POST /api/store/demo` (reset, external change, fault, scope changes) on SYNTHETIC stores under `NODE_ENV=production`. **Required for the Playwright e2e run against `npm run build && npm run start`**; never set it on a real deployment. |
| `CRON_SECRET` | Bearer token Vercel sends to `/api/cron/agents` and `/api/cron/weekly-summary`; both refuse everything else. |

## Checks

```bash
npm run typecheck && npm run lint && npm run test   # vitest, includes the RLS suite against DATABASE_URL
DEMO_CONTROLS=true npm run build && DEMO_CONTROLS=true npm run test:e2e   # Playwright against the production build (demo controls are needed for the resets)
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
