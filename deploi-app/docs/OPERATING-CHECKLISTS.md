# Operating checklists

Everything here runs against the staff tools. Nothing here sends a real message, charges a card
or touches a live vendor system until the separate authorisations listed under "Still disabled"
at the bottom have been given.

## First-client onboarding checklist

Before anything else, confirm the pipeline stage is `call_held` and the prospect has a named
owner contact.

1. **Assessment sold.** `/staff/assessments/new?prospect=…`: record the fee. This creates the agency,
   the assessment walkthrough and a ledger credit in state *unpaid*.
2. **Fee paid.** On the assessment page, "Record payment" (real) once the invoice is paid. Never use
   "Record mock payment" for a real client; it is labelled simulated and cannot be applied.
3. **Evidence.** Complete both traces. Fill the evidence panel: period, sample size, source reference,
   who supplied each number, and mark every input measured / owner-reported / assumed. Ask for an
   aggregate export (counts per month) instead of patient records.
4. **Leaks and report.** Calculate leaks, read the grades and the "illustrative" flags, generate the
   PDF (≤ 6 pages), hold the review meeting, log corrections the owner makes in the corrections log.
5. **Proposal.** `/staff/engagements/new?prospect=…&agency=…&assessment=…`: pick one catalog service,
   set fees inside the configured ranges, fill volume, overage terms, input format, milestones,
   acceptance criteria, contacts, support hours + timezone, escalation, fix period, initial term,
   exclusions and change-request process. Export the proposal PDF (it says it is not a contract).
6. **Acceptance.** Record acceptance evidence (email reference, signed PDF, portal) before moving to
   *Accepted*. A status change without evidence is refused.
7. **Credit.** Apply the ledger credit to the engagement (never to Website Improvement).
8. **BAA.** Upload and date the BAA on the agency page. It is one prerequisite, not proof of compliance.
9. **Onboarding items.** Work the checklist on the engagement page: configuration + timezone, named
   responsibilities (approval owner, escalation contact), data access authorisation, templates
   approved, consent information available, baseline captured, input source tested with a real
   export (a simulated test does not count), human escalation path, training, acceptance tests,
   pilot approval. Each item records who and when.
10. **Readiness.** All six dimensions must read ready before *Pilot*: configuration, data quality,
    security controls, integration verification, operational readiness, commercial readiness.
11. **Pilot.** Define dates, one primary workflow, scope and sample, baseline period, primary metric,
    guardrails, data sources, review owner, decision date. Compute the baseline.
12. **Launch.** Move to *Pilot*. Auto-send stays OFF. Every proposed action is approved by a person.

## Daily operating checklist (per business day, inside the engagement's support hours)

- `/staff/actions`: review *Waiting* and *Delivery unknown*. Approve, edit or skip. Anything
  simulated is labelled; it is not a real send.
- `/staff/queue`: open tickets by severity; set next action; close resolved ones.
- `/staff/evv`: check "last successful import" and the stale flag per agency; chase exports that
  are overdue; review new exceptions and the deadline column ("deadline not configured" means
  the rule set is missing, not that there is no deadline).
- Client dashboards: spot-check one agency's `/app/home` for data freshness and action items.
- Inbox: urgent inbound messages create an *admin* task action; handle them first.

## Weekly operating checklist

- Pilots: compute pilot measurements, compare with baseline, note sample sizes and missing data.
- Economics: log labor (review, support, troubleshooting) and costs; check contribution per agency
  (labelled "not net profit").
- Rules: confirm EVV rule sets still match their sources; update `source_version` when a payer
  bulletin changes a window.
- Imports: download fresh templates if a vendor export changed columns; re-map in the staging step.
- Consent: review opt-outs (STOP) and make sure no suppressed action was re-created.
- Credits: expiring credits in the next 14 days on the agency pages.
- Pipeline: `/staff/conversations` gate progress toward 10 held calls (live EVV connectors wait
  behind it).

## Website Improvement delivery checklist

1. Inquiry arrives as a prospect tagged *Website Improvement* with a website engagement in *Inquiry*.
2. Qualify: URL, platform, goal, up to three pages, requested changes, known problems, access status,
   approval contact. Confirm feasibility on the platform. No passwords anywhere.
3. *Scope confirmed* → send the scope (included items, exclusions, five-hour budget, one revision round,
   target of five business days after payment, access and content; a target, not a guarantee).
4. *Accepted* with acceptance evidence. *Payment confirmed* only after a real payment is recorded.
   A mock payment is visibly simulated and does not unlock the next step.
5. *Access received*: record the approved access arrangement (invited as editor, agency-managed, etc.).
6. Backup or rollback plan recorded, then *Improving*. Log hours as you go; the budget bar warns at
   80% and blocks at 100%: agree a smaller scope or quote more before continuing.
7. *Preview ready*: staging URL, or a direct-edit note with the rollback plan.
8. *Customer approved*: record the approval evidence (who, how, when).
9. *Published*: only possible with approval evidence. Verify every changed URL; record the checks.
10. *Completed*: before/after summary delivered, handoff summary saved, labor and contribution shown.
    Maintenance is a separate scope; never a subscription.

## Synthetic-data demonstration walkthrough

Local: `npm run db:reset && npm run dev`, sign in on `/login` (dev mode lists seeded users).

1. Staff `/staff/pipeline`: Buckeye Home Care (synthetic) is at *build sold*; Website Improvement
   leads carry the tag.
2. `/staff/assessments`: the Buckeye assessment has both traces, evidence statuses, graded leaks and a PDF.
3. `/staff/engagements`: the Buckeye referral-response engagement is in *Pilot* with transitions,
   onboarding items and baseline measurements.
4. `/staff/actions`: run a worker in dry-run from "Run a worker"; approve one action; it lands in the mock
   outbox and shows the *simulated* badge.
5. `/staff/evv`: import `tests/fixtures/generic-evv-sample.csv` for Buckeye; see row errors, duplicates and
   the deadline from the Ohio rule set (marked unverified); the control agency shows "deadline not configured".
6. `/staff/website`: a website engagement in *Improving* with labor against the five-hour budget.
7. `/staff/economics`: synthetic rates, labor, costs; contribution labelled; a mock revenue row excluded.
8. `/staff/queue`: two synthetic tickets.
9. Client user `/app/home`: tiles, active services, freshness, verified activity, limitations.
10. `/staff/emails/preview`: the morning email with counts and links only.

## Deployment instructions (prepared, not executed)

See `docs/DEPLOY.md` for the environment. For this build:

1. Apply migrations `20261021000017` … `20261021000027` in order with `npm run db:migrate:prod`
   (or `scripts/migrate-http.ts` through the Supabase Management API). All are additive. Rollback:
   none of them drop or rewrite existing columns; to roll back, drop the new tables and the new
   columns listed in the build report, in reverse order.
2. Run the seed only on a non-production database.
3. Set the configuration variables listed in the build report (names only; no values in docs).
4. Keep `AUTH_MODE=supabase`, `ALLOW_DEV_LOGIN=false`, no `RESEND_API_KEY`, no `TWILIO_*`,
   no `PAYMENTS_LIVE`, and every `agencies.auto_send` empty until each is authorised separately.
5. Deploy with the existing Vercel project; the crons in `vercel.json` are safe to run (job lock).

## Still disabled, by design, until separately authorised

Live messaging (email, SMS), live payments, automatic sending (auto-send), production migrations,
production deployment, live EVV connectors.
