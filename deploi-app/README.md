# deploi-app

The Deploi operating system: staff sales pipeline, assessment engine, client morning
report, operations workers and the EVV exception layer. Next.js 15 (App Router),
TypeScript strict, Tailwind, Postgres with row-level security (Supabase in production).

## Run locally

```bash
cp .env.example .env.local          # DATABASE_URL points at a local Postgres
npm install
npm run db:migrate                  # applies supabase/migrations (+ a local auth shim off-Supabase)
npm run seed                        # idempotent: Buckeye Home Care demo data
npm run dev                         # http://localhost:3000 -> /login (dev auth: pick a seeded user)
```

## Checks

```bash
npm run typecheck && npm run lint && npm run test   # vitest, includes the RLS suite against DATABASE_URL
npm run build && npm run test:e2e                    # Playwright
```

## HIPAA posture

- Every table has RLS: clients see only their agency, staff see all. Enforced in Postgres;
  the app always queries as the signed-in user (`lib/db.ts#withUser`).
- Every insert/update/delete on every table is audited by trigger. Reads are audited where the
  data layer calls `auditRead`: the client dashboard metrics and list pages, assessment views,
  the proposed-actions list, report and BAA downloads, and the billing-hold export. Reads on
  staff-only sales tables (prospects, touches) and some staff list pages are protected by RLS
  but not individually logged. Read-only viewer at `/staff/audit`. Audit rows carry actor,
  table, row id, action, time and IP; never document contents.
- Outbound network calls go through `lib/net/outbound.ts`: each provider purpose has an
  approved host list, and the PHI lane (`lib/phi` -> `lib/llm/local`) can only reach a private
  or explicitly allowed Ollama host at runtime, not just by lint.
- `lib/log.ts` redacts person-identifying keys before anything is written to logs.
- `lib/phi/*` may only call the local Ollama lane (`lib/llm/local.ts`); lint + a test enforce it.
- Email (Resend) and SMS (Twilio) are mocked whenever their env vars are empty.

## Layout

- `app/staff/*` staff area, `app/app/*` client area, `app/api/*` public API, webhooks, cron.
- `lib/` data layer, auth, llm lanes, adapters. `workers/` operations workers. `emails/` templates.
- `supabase/migrations/` schema; `scripts/` migrate, seed, proof screenshots.
