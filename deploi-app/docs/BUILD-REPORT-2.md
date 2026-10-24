# Build report: Deploi operations service (phases 3 to 19)

Repository `deploi-site`, branch `main`. Baseline before this build: `1a7e729`. Final commit: `0b69904`.
Everything below was implemented and verified locally. Nothing was deployed, no production data was
touched, no message was sent, no card was charged, no vendor system was contacted.

## Summary of changes and purpose

| Commit | Phase | Purpose |
|---|---|---|
| `60b42b9` | 3, 4, 5 | Current-state audit; structured service catalog (8 services, availability, inputs, responsibilities, limits, exclusions, success measures); draft pricing defaults read from configuration; integration levels; assessment credit ledger; job lock |
| `ae8e76d` | rules | Forbidden-name grep script that never contains the names |
| `d018c7a` | 17 | Runtime outbound-host boundary (PHI lane only reaches private hosts); mock-only payments adapter; narrowed audit claim; security e2e; operating checklists |
| `f4c0941` | 6, 16 (public) | Site: home care first, catalog-driven services/pricing/availability/integrations, six-stage journey, responsibilities, `/website` page and request form |
| `989eb02` | 14, 15 | Staff-only economics, service queue, client dashboard reporting sections, minimal morning email |
| `dc843be` | 16 (workflow) | Website Improvement engagements with gated ten-step workflow; lead tagging; pipeline filter |
| `beac3d7` | 9, 10, 13 | Engagements, proposals and PDF, acceptance evidence, onboarding checklist with six readiness dimensions, launch gates, pilots with never-count metrics |
| `ea1cbc1` | 7, 8 | Assessment evidence layer, categorised low/base/high loss calculations, six-page report, ledger-backed credits |
| `0b69904` | 11, 12 | Action execution safeguards, webhook fail-closed, job-locked crons, CSV import toolkit, EVV rule sets, integration |

## Acceptance table

| Phase | Status | Evidence |
|---|---|---|
| 3 Audit | Complete | `docs/CURRENT-STATE.md`; worker inventory reconciled (6 workers; 5 advertised services removed) |
| 4 Service catalog | Complete | `lib/catalog/services.ts`, `tests/catalog` (4 tests), site reads `src/data/catalog.json` with a sync test |
| 5 Commercial structure | Complete | `lib/catalog/pricing.ts` (env-configurable, defaults as specified), scope considerations, "not included in lowest price" list; tests assert the prices |
| 6 Public website | Complete | `src/pages/{Home,Website}.tsx`, 37 site tests, `proof/site-*.png` at 1440/390 incl. form error/success and 404 |
| 7 Assessment evidence | Complete | `lib/assessments/evidence.ts`, `lib/leaks.ts` categories/grades/bounds/frequency basis, PDF 6 pages (test counts pages), 34 tests |
| 8 Assessment credits | Complete | `lib/credit/ledger.ts`, migration 0017/0018, 11 ledger+credit tests (mock payment unusable, no double application, history) |
| 9 Engagements/proposals | Complete | `lib/engagements/*`, proposal PDF labelled not a contract, acceptance evidence enforced in lib and DB trigger, 17 tests |
| 10 Onboarding gates | Complete | `lib/onboarding/*`, 13 items, 6 dimensions, gates server-side, simulated/mock never satisfies, 14 tests |
| 11 Action safeguards | Complete | `lib/workers/runtime.ts` + `outcomes/suppress/inbound/expiry/window/webhook-guard`, `docs/action-safeguards.md`, 85 ops tests incl. idempotent retry, opt-out, expiry, lock, 503 without secret |
| 12 CSV + EVV rules | Complete (CSV only by design) | `lib/imports/*`, `lib/evv/window.ts` rule resolver (null deadline → "deadline not configured"), `visit_revisions`, advisory billing hold, `/staff/evv/rules`; live connectors remain stubs behind the gate |
| 13 Pilot measurement | Complete | `lib/pilots/metrics.ts` with denominators and never-count rules (11 metric tests), pilot UI, decisions |
| 14 Internal economics | Complete | `lib/economics/*`, `/staff/economics*`, RLS denies clients (tested), mock revenue excluded, contribution labelled |
| 15 Client reporting + queue | Complete | `/app/home` sections, `lib/dashboard/urgency.ts`, `service_tickets` + `/staff/queue`, morning email tested against every seeded name, duplicate-safe send |
| 16 Website Improvement | Complete | Site page + form; `website_engagements` ten-step gated workflow; mock payment never satisfies the gate; publication requires approval evidence; 23 website/api tests |
| 17 Security | Complete for what is verifiable locally | Outbound boundary test, PHI lane runtime guard, webhooks fail closed in production, RLS tests on every new table, audit claim narrowed in README and site; see "Remaining production risks" |
| 18 Testing | Complete | Full suite `Test Files 53 passed, Tests 296 passed`; site 37/37; typecheck clean; lint 0 errors; `next build` clean (64 routes); Playwright 9/9 (flow + security); 1440/390 proofs of every new screen |
| 19 Deliverables | Complete | This file, `docs/OPERATING-CHECKLISTS.md`, `docs/CURRENT-STATE.md`, `docs/action-safeguards.md`, `docs/evv-connectors.md` |

The 18 required test behaviours map to: 1 `tests/db/rls.test.ts` + every stream's RLS test + `e2e/security.spec.ts`; 2 `tests/economics/access.test.ts` + e2e; 3 `tests/workers/execution.test.ts`; 4 `tests/consent/*`; 5 execution retry test; 6 `isRealOutcome` tests + dashboard sections test; 7 `tests/imports/toolkit.test.ts`; 8 `tests/evv/rulesets.test.ts`; 9 unit-conversion tests; 10 `lib/leaks.test.ts` double-count test; 11 `tests/credit/ledger.test.ts`; 12 `tests/onboarding/gates.test.ts` + `tests/engagements/workflow.test.ts`; 13 site `pages.test.tsx` + `tests/catalog`; 14 `tests/api/lead.test.ts`; 15 `tests/website/workflow.test.ts`; 16 same; 17 ledger + website payment tests + `tests/unit/adapters.test.ts`; 18 `tests/website/workflow.test.ts` RLS cases.

## Routes added or changed

Staff: `/staff/engagements`, `/staff/engagements/new`, `/staff/engagements/[id]`, `/staff/engagements/[id]/proposal.pdf`,
`/staff/website`, `/staff/website/[id]`, `/staff/economics`, `/staff/economics/rates`, `/staff/economics/log`,
`/staff/queue`, `/staff/queue/[id]`, `/staff/evv/rules`; changed `/staff/actions`, `/staff/evv`, `/staff/evv/import`,
`/staff/actions/applicants/import`, `/staff/assessments/*`, `/staff/agencies/[id]`, `/staff/pipeline*`.
Client: `/app/home` (new sections). API: `/api/public/lead` (v2 fields), `/api/webhooks/twilio/status` (new),
`/api/imports/template/[kind]` (new), `/api/evv/billing-hold.csv` (advisory columns), crons under the job lock.
Site: `/website` (new); home, `/baa`, `/evv`, legal pages revised.

## Schema changes (all additive)

| Migration | Adds |
|---|---|
| `20261021000017_credit_ledger` | `assessment_credits`, `assessment_credit_applications` (+ backfill from legacy columns) |
| `…018_assessment_evidence` | `assessments.evidence`, `assessment_credits.payment_recorded_by/payment_note` |
| `…019_engagements` | `engagements`, `engagement_transitions`, trigger `engagements_status_guard` |
| `…020_onboarding` | `onboarding_items` |
| `…021_pilots` | `pilots`, `pilot_measurements` |
| `…022_job_runs` | `job_runs` |
| `…023_action_execution` | `proposed_actions` state columns (approved/queued/attempted/delivered, delivery_status, simulated, expires_at, suppressed_reason, idempotency_key…), `sms_opt_out_at` on aides/applicants/clients, `simulated` on shift_offers/referrals/applicants/retention_checkins, `retention_checkins.answered_at`, functions `suppress_pending_actions`, `retire_followups_on_change`; backfills legacy `sent` rows as delivered + simulated |
| `…024_imports_evv_rules` | `imports`, `visit_revisions`, `evv_rule_sets`, `visits.import_id`, `applicants.import_id`, `evv_exceptions.rule_set_id`, provenance columns on `evv_imports` |
| `…025_economics` | `internal_rates`, `labor_entries`, `cost_entries`, `revenue_entries` |
| `…026_service_tickets` | `service_tickets`, function `agency_last_worker_run` |
| `…027_website` | `prospects.service_interest/tags/website_url/website_goal/website_details`, `website_engagements`, `website_labor`, `website_transitions`, functions `public_create_lead_v2`, `website_strip_secret_keys` |

Every new table has RLS (tenant or staff-only), grants, and an audit trigger. Internal rates, labor, costs,
revenue, tickets, website records, engagements' commercial fields and job runs are staff-only.

## Migration order and rollback

Apply 0017 → 0027 in file order with `npm run db:migrate:prod` (direct) or `scripts/migrate-http.ts`
(Supabase Management API). They are idempotent and only add. Rollback is manual, in reverse order:
drop the tables listed above for the migration, then its added columns and functions. 0023's backfill
(legacy `sent` → `delivered` + `simulated=true`) is reversible by `update proposed_actions set status='sent'
where simulated and delivered_at is null`. Keep 0017's backfilled credits (state *unpaid*) until payment is confirmed.

## Tests run (actual results, 2026-10-24)

- `deploi-app`: `npx vitest run` → Test Files 53 passed, Tests 296 passed. `npm run typecheck` clean.
  `npm run lint` 0 errors, 0 warnings. `npm run build` compiled (64 routes). `npx playwright test` 9 passed
  (`e2e/flow.spec.ts` 6, `e2e/security.spec.ts` 3) against `next start` with the seeded dev database.
- Per-stream suites also ran on isolated databases: assess 34, engage 49, ops 85, econ 38, web+sales 38.
- `deploi-site`: typecheck, lint clean; vitest 37 passed; `vite build` ok.
- Forbidden-name grep clean on every commit.

## Working versus simulated

Working end to end on synthetic data: pipeline, assessments with evidence and report, credit ledger,
engagements/proposals/onboarding/pilots, worker proposals and the approval/execution state machine,
CSV imports with validation and provenance, EVV rules and deadlines, economics, queue, client dashboard,
morning email rendering, website workflow, lead intake.
Simulated: every email and SMS (mock adapters, rows marked `simulated`), every payment (mock-only adapter;
"Record payment" is a staff attestation that money moved elsewhere), provider delivery callbacks
(exercised in tests only), the Ohio PASSPORT rule set (seeded as unverified). All services are marked
*Demonstration* until a real customer runs them.

## Blocked dependencies

- Live email/SMS: no credentials, and sending is forbidden in this task. Twilio status callback and Resend
  delivery events need the provider configuration once authorised.
- Payments: no live path exists by design (`PAYMENTS_LIVE` + key would still hit NotImplemented).
- Live EVV connectors: out of scope; stubs stay behind the 10-conversation gate (seed shows 6/10).
- Production migration and deployment: forbidden; prepared above.
- Supabase BAA and plan tier: visible on `/staff/setup`, not satisfiable from code.

## Configuration variable names (no values)

New: `ASSESSMENT_PRICE_MIN`, `ASSESSMENT_PRICE_MAX`, `ASSESSMENT_CREDIT_TERM_DAYS`, `BUILD_PRICE_MIN`,
`BUILD_PRICE_MAX`, `BUILD_FIX_PERIOD_DAYS`, `MANAGEMENT_PRICE_MIN`, `MANAGEMENT_PRICE_MAX`,
`MANAGEMENT_INITIAL_TERM_MONTHS`, `WEBSITE_IMPROVEMENT_PRICE`, `WEBSITE_IMPROVEMENT_HOURS`,
`WEBSITE_IMPROVEMENT_TARGET_DAYS`, `ACTION_DELIVERY_UNKNOWN_AFTER_MIN`, `ACTION_EXPIRY_HOURS_DEFAULT`,
`ACTION_REFERRAL_REPLY_EXPIRY_HOURS`, `CONTACT_WINDOW_DEFAULT`, `URGENT_KEYWORDS`, `IMPORT_STALE_DAYS`,
`IMPORT_STALE_DAYS_EVV_VISITS`, `IMPORT_STALE_DAYS_APPLICANTS`, `IMPORT_STALE_DAYS_AIDES`,
`OLLAMA_ALLOWED_HOSTS`, `PAYMENTS_LIVE` (must stay unset).
Now required in production (webhooks fail closed without them): `TWILIO_AUTH_TOKEN`, `RESEND_WEBHOOK_SECRET`,
`SMARTLEAD_WEBHOOK_SECRET`, `APPLICANT_WEBHOOK_SECRET`, `CRON_SECRET`.
Removed: `EVV_CORRECTION_WINDOWS`, `EVV_DURATION_TOLERANCE_MIN` (rule sets replace them).
Test-only: `ASSESS_/ENGAGE_/OPS_/ECON_/WEB_/JOBS_TEST_DATABASE_URL`.

## Checklists and walkthrough

First-client onboarding, daily and weekly operating, Website Improvement delivery, the synthetic-data
walkthrough and deployment instructions are in `docs/OPERATING-CHECKLISTS.md`.

## Remaining production risks

1. No service has run for a real customer; every availability status is *Demonstration* and the site says so.
2. Delivery confirmation depends on provider callbacks that have never fired against this code.
3. The EVV correction window for Ohio is a working assumption (`verified=false`); confirm with ODM per program before relying on a deadline.
4. Audit coverage of reads is partial (listed in README); staff list pages are protected by RLS but not read-logged.
5. The PHI lane has no caller in production paths yet; the runtime guard is tested but has not seen traffic.
6. Legacy credit columns on `agencies` are mirrored from the ledger; a direct write to them would be ignored by the ledger.
7. `AUTH_MODE=dev` / `ALLOW_DEV_LOGIN=true` are still set on the deployed Vercel project from the earlier demo; flip to `supabase` / `false` before any real login.
8. Building is not production readiness: the gates above, a signed hosting BAA, verified provider setup and a real pilot decision are still required.

## Still disabled pending separate authorisation

Live messaging, live payments, automatic sending, production migrations, production deployment, live EVV connectors.
