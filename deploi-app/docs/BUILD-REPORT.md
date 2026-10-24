# Deploi — build report (section 10 format)

Repo: `deploi-site` on GitHub (branch `main`). The app lives in that repo under `deploi-app/` because this session could not create a second repository (see decisions). Proof images: site in `proof/`, app in `deploi-app/proof/`.

## Sections 2–8

| Section | Commit SHA(s) | Tests passing | Screenshot pair |
|---|---|---|---|
| 2 Marketing site | 5301839, 38f0eee, 2318520 | 13 (vitest) | proof/site-home-1440.png, proof/site-home-390.png |
| 3 App foundation | a4f3447, 078b310, 2e61140, 5033860 | 21 (unit + RLS + lead API) | deploi-app/proof/staff-audit-1440.png, deploi-app/proof/staff-audit-390.png |
| 4 Sales machine | 8f71f9c | 15 | deploi-app/proof/staff-pipeline-1440.png, deploi-app/proof/staff-pipeline-390.png |
| 5 Assessment engine | eba1cad | 12 | deploi-app/proof/staff-assessment-report-1440.png, deploi-app/proof/staff-assessment-report-390.png |
| 6 Morning report dashboard | 18033c0 | 9 | deploi-app/proof/app-home-1440.png, deploi-app/proof/app-home-390.png |
| 7 Operations workers | a3585bb | 23 | deploi-app/proof/staff-actions-1440.png, deploi-app/proof/staff-actions-390.png |
| 8 EVV exception layer | 9aba278 | 27 | deploi-app/proof/staff-evv-1440.png, deploi-app/proof/staff-evv-390.png |
| 9 Gates | eef4d15 | app vitest 107/107 (24 files); site vitest 13/13; Playwright e2e 6/6 | all 16 below |

Typecheck and lint: clean in both packages.

The 16 required screenshots: proof/site-home-{1440,390}.png, proof/site-menu-open-{1440,390}.png, proof/site-evv-{1440,390}.png, deploi-app/proof/staff-pipeline-{1440,390}.png, deploi-app/proof/staff-assessment-report-{1440,390}.png, deploi-app/proof/app-home-{1440,390}.png, deploi-app/proof/staff-actions-{1440,390}.png, deploi-app/proof/staff-evv-{1440,390}.png.

## Lighthouse (performance / accessibility)

| Page | Mobile | Desktop |
|---|---|---|
| Homepage, live (gotdeploi.com, commit 38f0eee) | 87 / 95 | 94 / 96 |
| Homepage, local production build after 2318520 | 100 / 95 | — |
| Homepage, live after 2318520 | 94 / 95 | 98 / 96 |
| /app/home (production build, signed-in client) | 99 / 100 | 100 / 100 |
| /staff/pipeline (production build, signed-in staff) | 98 / 100 | 100 / 100 |

The one accessibility flag on the homepage is the © line at #666 on black, which the brief mandates.

## RLS test

`tests/db/rls.test.ts` (10/10): "RLS: client A reading agency B visits -> 0 rows". Client A sees exactly its 300 visits with no filter; client B sees its 10; staff sees 310; a client cannot read prospects, touches, other profiles or the audit log; cross-agency inserts are rejected; writes and reads are audited with actor, agency and IP.

## Grep

Case-insensitive grep for the three strings forbidden by hard rule 1 over the whole deploi-site checkout (site + deploi-app, excluding node_modules/.git/build output): no matches.

## Env vars to set in Vercel

Project `deploi-site` (exists):
- `VITE_APP_API_URL` — `https://app.getdeploi.com` once the app project is live; the site posts leads to `${VITE_APP_API_URL}/api/public/lead`.
- `VITE_BOOKING_URL` — your Cal.com/Calendly event link; hero and final CTA open it in a new tab.
- `VITE_FORMSPREE_ENDPOINT` — Formspree form endpoint; fallback only when VITE_APP_API_URL is empty.
- `VITE_LEGAL_ENTITY` — the LLC name shown on /terms (renders "Deploi" when empty).
- `VITE_LEGAL_REVIEWED` — set to `true` after counsel signs off to hide the draft badge.

Project `deploi-app` (create it: import the deploi-site repo, Root Directory `deploi-app`, domain `app.getdeploi.com`):
- `DATABASE_URL` — Supabase → Project Settings → Database → Transaction pooler URI.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API.
- `AUTH_MODE` — `supabase` in production (dev auth is only for local/preview demos).
- `APP_SECRET` — any 32+ random characters (`openssl rand -base64 32`); signs dev sessions.
- `STAFF_EMAILS` — comma-separated staff logins (you and Ojae); everyone else is a client. Also run `alter database postgres set app.staff_emails = '...'` in Supabase so the profile trigger agrees.
- `NEXT_PUBLIC_APP_URL` — `https://app.getdeploi.com`; `NEXT_PUBLIC_SITE_URL` — `https://getdeploi.com`.
- `PUBLIC_API_ALLOWED_ORIGINS` — `https://getdeploi.com,https://www.getdeploi.com` (CORS for the lead API).
- `BOOKING_URL` — same booking link as the site; used by the prospect page "Book call".
- `RESEND_API_KEY` — Resend → API Keys (domain getdeploi.com verified, from hello@getdeploi.com). `RESEND_WEBHOOK_SECRET` — Resend → Webhooks (inbound referrals, svix signing secret). `STAFF_NOTIFY_EMAIL` — inbox for the 7 AM pipeline email.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — Twilio console; the auth token also validates the SMS webhook.
- `SMARTLEAD_WEBHOOK_SECRET` — Smartlead → Settings → Webhooks (secret_key); point the webhook at `/api/webhooks/smartlead`.
- `APPLICANT_WEBHOOK_SECRET` — any random string; bearer token for `/api/webhooks/applicant` (job-board integrations).
- `CRON_SECRET` — any random string; Vercel sends it on cron calls (`/api/cron/morning-pipeline`, `/api/cron/morning-report`, `/api/cron/workers`).
- `OLLAMA_URL`, `OLLAMA_MODEL` — a reachable Ollama host (default llama3.1:8b); `LLM_MOCK=1` until one exists. Vercel cannot run Ollama; the PHI lane needs a private host.
- `LLM_CLOUD_PROVIDER`, `LLM_CLOUD_API_KEY`, `LLM_CLOUD_MODEL` — optional; sales-data-only lane (openai | anthropic | ollama).
- `ASSESSMENT_PRICE`, `BUILD_PRICE_RANGE`, `RETAINER_RANGE` — pricing strings on the report (defaults match the site).
- EVV correction windows and unit rules are configured per program/payer/state in `evv_rule_sets` (/staff/evv/rules), not in the environment.
- `STORAGE_BUCKET` — `reports` (private Supabase Storage bucket for assessment PDFs).

## Decisions made without asking

- deploi-app lives in `deploi-site/deploi-app/` (own package, own Vercel root) because this session's GitHub token cannot create repositories; `git subtree split -P deploi-app` moves it to its own repo in one command.
- Vercel project `deploi-app`, its domain, and env vars were not created: the session's Vercel token is read-only (403 on project, env and domain writes); steps are in `deploi-app/docs/DEPLOY.md`.
- No Supabase access token in the session, so "deploi-prod" was not created; migrations were verified against a local Postgres 16 with a shim that reproduces `auth.uid()` so the same RLS policies ran unchanged.
- Data access goes through Postgres directly (`DATABASE_URL`) as the signed-in user with RLS enforced, Supabase used for Auth and Storage; one code path for local, preview and production.
- Dev auth mode (role picker over seeded users, signed cookie) exists for local demos and the e2e suite; it is off when Supabase is configured.
- A second tiny "RLS control" agency with 10 visits is seeded so the tenancy test has a neighbour to fail to read.
- The seed holds 5 held owner conversations (brief implied 4); the gate counts prospects at call_held or later.
- Morning emails run on an hourly cron gated by local time (7 AM agency timezone / ET) and deduped per day in `worker_runs`; workers run nightly 06:00 UTC. Hobby-plan Vercel allows only daily crons.
- `getdeploi.com` returns a Squarespace "Coming Soon" page; the Vercel project serves `gotdeploi.com`. Attaching getdeploi.com to the project needs a dashboard change this token cannot make.
- Three-card grids on the site use 3 columns at ≥1120px; chat speech card hidden below 600px; social links are placeholder handles; nav gained an "EVV" link.
- Leak formulas carry documented assumptions (on-time threshold 1h, $26/h aide cost at 35% margin, $2,500 replacement cost per aide, 50% of denials unrecovered).
- Referral reply drafts use the local Ollama lane with a template fallback when Ollama is unreachable; nothing PHI-adjacent ever calls a cloud provider (lint rule + test enforce it).
- All workers default to auto-send OFF; approve-and-send and auto-send share one send path so side effects are identical.
- Lighthouse for the app pages was run on the local production build with a signed session (no app deployment exists yet).
- The site's Vercel builds had been failing since section 2 on an `@eslint/js` v10 peer conflict; pinned to v9 in 38f0eee and the deploy went green.
