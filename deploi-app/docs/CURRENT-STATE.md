# Current state audit (before the operations-service build)

Audited on 2026-10-21 against `deploi-site` main at `1a7e729`. Method: read the code, ran
`npm run typecheck && npm run lint && npm run test` locally (140/140 pass, 1 lint warning),
inspected the schema (`supabase/migrations/0001…0016`), the routes under `app/`, the worker
runtime, adapters and webhooks. "Verified" below means a test or a local run proves it.

## Worker inventory (reconciled)

The code has exactly **six** workers (`workers/*.ts`, `lib/workers/types.ts#WORKER_NAMES`):

| Worker | Door | Nightly | Proposes |
|---|---|---|---|
| `referral_response` | Growth | yes | reply email to referrer, intake follow-ups |
| `applicant_screening` | Staffing | yes | screening SMS, interview booking |
| `retention_checkins` | Staffing | yes | 30/60/90-day check-in SMS |
| `credential_tracking` | Staffing | yes | aide SMS + admin email before expiry |
| `open_shift_fill` | Operations | yes | shift offers to aides, family confirmation |
| `authorization_watch` | Operations | yes | low-units / expiring-auth email to admin |

The marketing site advertised **eleven** services. Five of them have no worker and no code
path: "New-patient leads + reviews", "Referral-source nurturing", "Instant hiring" (partly:
screening exists, job posting does not), "After-hours line", "Denial cleanup + managed billing".
The site also described the service as for "small practices: home care, dental, therapy,
primary care and specialty clinics"; every worker, rule and seed is home-care specific.
Both inconsistencies are fixed in this build (service catalog, phase 4; site, phase 6).

## Capability table

| Capability | Status | Evidence |
|---|---|---|
| Referral and visit traces (6 + 8 steps) | Implemented, verified | `lib/assessments/steps.ts`, `tests/assessments/engine.test.ts` |
| Operational-loss calculations | Implemented, verified, **but** extrapolates from a single trace, has no input provenance, no low/base/high, and mixes categories (turnover replacement cost is presented like lost revenue) | `lib/leaks.ts`, `lib/leaks.test.ts` |
| Assessment report PDF ≤ 6 pages | Implemented, verified | `lib/report/pdf.tsx`, e2e |
| Assessment-fee credit | Implemented but unverified for history: one amount on `agencies`, `applied_at` guard prevents a second apply, no ledger, no payment status | `lib/assessments/actions.ts#applyCredit`, `tests/credit` |
| Six workers producing proposals | Implemented, verified | `tests/workers/*` |
| Proposed actions with human review (approve / edit / skip) | Implemented, verified. States are only `proposed → sent/skipped`; no queued / attempted / delivered / failed / unknown; no expiry; **a mocked send is recorded as `sent`** | `lib/workers/runtime.ts#sendProposedAction` |
| SMS consent checked before send | Implemented, verified | `lib/consent/check.ts`, `tests/consent` |
| Per-agency auto-send default off | Implemented, verified (`agencies.auto_send` default `{}`) | `tests/workers/runtime.test.ts` |
| Opt-out (STOP) suppresses pending outreach | **Missing** | Twilio webhook only routes YES/NO and screening answers |
| Replies / filled shifts stop obsolete follow-ups | Partial: a YES marks other offers superseded; referral and applicant follow-ups are not cancelled on reply | `workers/open_shift_fill.ts` |
| Idempotent retries / duplicate jobs | Partial: `dedupe_key` unique on proposals; no lock on cron runs, morning report guarded by `worker_runs` row per day | `app/api/cron/*` |
| Webhook authentication | Partial: Twilio, Resend, Smartlead, applicant endpoints verify **only when their secret is set**; with no secret they accept everything (Smartlead logs a warning) | `app/api/webhooks/*` |
| CSV EVV exception detection (7 rules) | Implemented, verified | `lib/evv/rules.test.ts`, `tests/evv/ingest.test.ts` |
| Correction-window deadlines | Implemented, **but** the 60-day Ohio figure is a hard-coded default applied to every agency; no rule source, version, program or effective date; unknown jurisdictions silently get 60 days | `lib/evv/window.ts`, `lib/env.ts#evvWindows` |
| Unit conversion | Implicit (duration ÷ 15 min, rounding not stated) | `lib/evv/mappers.ts` |
| Visit evidence on re-import | Overwritten silently (upsert); corrected exceptions are preserved | `lib/evv/ingest.ts` |
| EVV import: staging, mapping preview, provenance | Implemented, verified; no template download, no row-level error list, no stale-data flag | `app/staff/evv/import`, `evv_imports` |
| Applicant CSV import | Implemented, minimal (phone dedupe only, no preview) | `app/staff/actions/actions.ts#importApplicants` |
| Billing-hold CSV | Implemented; not labelled advisory | `app/api/evv/billing-hold.csv` |
| Morning report (tiles + email) | Implemented, verified | `lib/dashboard`, `emails/morning-report.tsx` |
| Pipeline + discovery-call gate (10) | Implemented, verified | `tests/sales/calls-and-gate.test.ts` |
| Mock email / SMS adapters | Implemented, verified: mock whenever keys are empty | `tests/unit/adapters.test.ts` |
| Mock payment adapter | **Missing**: there is no payment adapter at all; Stripe appears only as a key-presence check on /staff/setup | `lib/setup/readiness.ts` |
| Vendor connector stubs | Implemented: four stubs throw NotImplemented; status not visible in the UI | `lib/evv/connectors`, `docs/evv-connectors.md` |
| Tenant isolation (RLS) | Implemented, verified for the tenant tables | `tests/db/rls.test.ts` |
| Audit "every read and write" | **Over-claimed.** Writes: trigger on every table. Reads: only where the data layer calls `auditRead` (dashboard metrics, assessments, actions list, report download, BAA download). Pipeline, agency pages, EVV lists and several client list pages read without an audit row | `lib/db.ts`, `README.md` |
| PHI model routing | Lint rule + import test only; `lib/phi/index.ts` has no callers today, so no runtime path exists to verify | `tests/unit/phi-boundary.test.ts` |
| Engagements / proposals / pilots | **Missing** | |
| Onboarding checklist / launch gates | **Missing** (`/staff/setup` reports Deploi-level provider readiness only and "blocks nothing") | `app/staff/setup` |
| Internal economics | **Missing** | |
| Staff service queue | **Missing** | |
| Website Improvement offer | **Missing** (site, lead tagging, workflow) | |
| Structured service catalog | **Missing** (pricing strings in `lib/env.ts`, service list hard-coded in the site) | |

## Blocked

- Live email, SMS, payments: no credentials in this environment and the brief forbids sending or charging. Adapters stay mocked.
- Live EVV connectors: out of scope by the brief; the discovery-call gate stays.
- Production migrations and deployment: forbidden by the brief; migrations are prepared and documented only.

## What this build changes

See `docs/BUILD-REPORT-2.md` for the acceptance table per phase, schema changes, tests and remaining risks.
