# Deploi readiness — 2026-11-05 (Final Master Build Brief)

Branch `claude/deploi-operating-system`, draft PR #16 (Jamesrevenueai/deploi-site). It contains the
2026-11-04 full-platform build plus today's work. **Not merged, not deployed.** Production still runs
`main` @ e7d2b6c with migrations through 035. No migration on this branch has been applied to any real
database.

Status labels (brief §21): **Implemented** · **Locally tested** (automated tests against local Postgres,
synthetic providers and fake HTTP layers that check request shapes, plus browser tests against a
production build) · **Live-tested** · **Deployed** · **Blocked** · **Not implemented**.

**Nothing is Live-tested and nothing is Deployed.** This environment has no Shopify, WooCommerce,
Resend, HubSpot, Google, QuickBooks, Microsoft or Stripe credentials.

## 1. Test evidence (head of the branch)

| Check | Result |
|---|---|
| Unit + integration (`npx vitest run`, freshly created database) | **754/754**, 107 files (577 at the start of today) |
| Browser tests against `next build` (`npx playwright test`) | **45 passed, 3 skipped** (the embedded Shopify app needs real Shopify credentials) |
| Typecheck, lint, production build | clean / clean / succeeds |
| Website (`npm test`, `npm run build`) | 60/60; build succeeds |
| Release rehearsal 036–044 (`scripts/test-release-2026-11-04-migrations.sh`) | passes (from 2026-11-04) |
| Release rehearsal 045–051 (`scripts/test-release-2026-11-05-migrations.sh`) | passes: production host refused; the dry run leaves nothing; apply keeps existing rows; 135 app tests pass on the migrated copy; rollback refuses while data exists; `--discard-data` rollback restores the schema **byte for byte**; re-apply works |
| Restore rehearsal (`scripts/restore-rehearsal.sh`) | passes: 108 tables, row counts, RLS and 10 audit chains verified |
| Forbidden-name scan | clean |
| Vercel preview of PR #16 | Ready. The first build failed fetching Google Fonts; the same commit then built cleanly. |

## 2. What was built today

| Brief area | Status | Where / evidence |
|---|---|---|
| **Resolution Engine** (§5): unique `DC-` case reference, one lifecycle, evidence, owner agent, next check, verification criteria, verified outcome; one open case per problem; append-only history; durable checks; handoffs that grant nothing | Locally tested | Migration 045, `lib/cases`, `tests/cases/*`. The database refuses a resolved case without a verified outcome. |
| **Business Discovery + autonomous onboarding** (§4): durable discovery job; tenant-isolated business profile (counts with source and time); findings become cases; a recommended team; one-click setup at drafts only; grant-all bound to each shown hash; ≤ 3 owner calls from connection to an active monitoring agent | Locally tested | Migration 049, `lib/discovery`, `tests/discovery/*`, `e2e/discover.spec.ts` |
| Detectors: store issues, low inventory, store health, supplier exceptions, neglected leads, unanswered mail, overdue invoices | Locally tested | `lib/discovery/detectors/*` (all registered) |
| **Commerce flagship: Supplier Exception Resolution** (§9): purchase-order CSV import (strict, idempotent, unambiguous SKU match), four exception rules, Supplier Coordinator, reply parsing as data, resolution options that need approval, verify-then-resolve, follow-up then escalate | Locally tested; live **Blocked** | Migration 046, `lib/commerce/*`, `tests/commerce/*` (28) |
| **Office flagship: CRM Follow-Up and Commitment Resolution** (§10): leads, meetings and CRM commitments as cases; a meeting counts only once it is read back from Google Calendar with the lead as attendee; opt-outs stop and close; exhausted cadence escalates; handoff to the scheduler grants nothing | Locally tested; live **Blocked** | Migration 047, `lib/office/{resolution,case-sync}.ts`, `tests/office/resolution-*` |
| **Email Operations Agent** (unanswered mail on the Deploi mailbox) | Locally tested | `lib/office/email-ops.ts`. It does not read Outlook or Gmail inboxes (those adapters report reply senders and times only). |
| **QuickBooks Online + Accounts Receivable Agent**: Intuit OAuth bound to `realmId`, rotating refresh, revoke on disconnect, read-only client, signed webhook; reminders only to the invoice's billing email; a dispute escalates; resolved only when a fresh read shows a zero balance | Locally tested; live **Blocked** | Migration 048, `lib/office/{quickbooks,receivables}*.ts`, `docs/QUICKBOOKS-SETUP.md` |
| **Customer experience** (§13): light theme; nav Home / My AI Team / Work in Progress / Needs My Approval / Completed Work / Inbox / Business Insights / Integrations / Billing / Settings; case detail with timeline, evidence, decisions and verification; "We found work your AI team can handle." first run; Settings with members, retention and deletion | Locally tested (e2e + screenshots `proof/ui-*`) | `components/work/*`, `components/discover/*`, `app/store/*` |
| **Website** (§18): Home, Office, Commerce, How It Works, Integrations (no integration marked Available until live-verified), Agents, Pricing (hypotheses labelled as pilot pricing), Security (no certifications claimed), Contact, Signup, Legal (DRAFT) | Locally tested | `src/**`, `src/lib/site-config.ts` |
| **Cost control** (§15): AI gateway (routine vs. complex routing, per-call caps, hourly runaway guard, per-agent and per-org monthly budgets, schema-validated output treated as data), usage metering, workflow cost counters, unit economics with cost per verified resolution | Locally tested. `AI_PROVIDER=off` by default; no model is called today. | Migration 051, `lib/ai`, `lib/platform/economics.ts`, `/staff/unit-economics` |
| **Configurable pricing** (§16): plans table; the brief's $149 / $299 / $499 seeded as `hypothesis`; edits by staff only, audited; hypothesis plans refused for live checkout; prices final only on approval by `PRICING_APPROVER_EMAILS` | Locally tested | `lib/plans/catalog.ts`, `/api/staff/plans` |
| **Role-based access** (§12, §17; closes F-08): owner / admin / member / viewer; only owners and admins grant, widen or allow autonomy; viewers read only; the last owner is protected | Locally tested | `lib/platform/rbac.ts`, every grant and approve path |
| **Account deletion + data retention + backups** (§17): owner-only deletion with a 7-day cooling-off and cancel; provider tokens revoked; legal and billing records kept; retention jobs; restore rehearsal | Locally tested | `lib/platform/{deletion,retention}.ts`, `docs/{BACKUP-RESTORE,DATA-RETENTION,MONITORING}.md` |

Defects found and fixed during integration:
- Three Office tests depended on the time of day.
- The Settings page probed an endpoint that does not exist.
- The new staff page reused the URL of a retired consulting page.
- QuickBooks was missing from the business profile and from one-click setup.

## 3. Acceptance tests (brief §20)

| # | Test | Status |
|---|---|---|
| 1 | A customer can create an account | Implemented (Supabase Auth). In production, sign-up is open with the F-02 hole (§5): fix before inviting anyone |
| 2 | Connect supported software | Locally tested (Shopify, WooCommerce, HubSpot, Google Calendar, QuickBooks, Deploi mailbox); **Blocked** live |
| 3 | Discovers actual business data | Locally tested on synthetic stores and providers; **Blocked** live |
| 4 | Identifies a real supported issue | Locally tested; **Blocked** live |
| 5 | Agents configure themselves | Locally tested (one-click setup, drafts only) |
| 6 | Customers understand and approve permissions | Locally tested (readable summaries, hash-bound grants, roles) |
| 7 | Agents execute real authorized actions | Locally tested; **Blocked** live |
| 8 | External messages sent and received | Locally tested; **Blocked** live (Resend domain) |
| 9 | Agents track unresolved work over time | Locally tested (durable case checks) |
| 10 | Recover from routine failures | Locally tested (leases, backoff, unknown outcomes reconciled, never re-sent) |
| 11 | Completed cases have evidence | Locally tested (enforced by the database) |
| 12 | Customers can inspect work history | Locally tested (case detail, audit log) |
| 13 | Pause or revoke agents | Locally tested (per agent, org-wide stop) |
| 14 | Customer data isolated | Locally tested (catalog-driven isolation tests over every table) |
| 15 | Subscription billing works | Locally tested against fake Stripe; **Blocked** live (Stripe account and prices; prices await owner approval) |
| 16 | Production monitoring operational | Implemented (health endpoint, `docs/MONITORING.md`); **Blocked**: uptime checks and log drains need the owner |
| 17 | No unresolved critical security defects | **Fails in production today** (F-02, below). On the branch: none known open at critical severity |
| 18 | One Office + one Commerce workflow live end to end | **Blocked**: both flagships are locally tested only |

**Verdict:** not ready to advertise either suite as commercially ready, and not ready for paying pilots until §5 items 1–4 are done and one Office and one Commerce workflow have passed a live run.

## 4. Security findings

- **F-02 (critical), live in production now.** On `deploi-prod`, email sign-up is open (re-checked read-only today: `disable_signup: false`) and the sign-up trigger trusts user-supplied metadata, so anyone can make themselves staff. The fix is migration 042 on this branch; disabling sign-up closes it today.
- F-07 (Shopify customer-privacy webhooks say "no customer data held"): must change before order or customer agents ship.
- Preview hygiene from 2026-11-04 is still open: a Vercel variable whose *name* is a 32-hex string; the Shopify dev secret marked "rotate after testing".
- Open on the branch, lower severity:
  - member invites are recorded but no invite email is sent;
  - Office provider calls are not cost-metered;
  - Outlook and Gmail inboxes are not read by Email Operations;
  - quarantined senders are never answered, so Email Operations finds little on a new mailbox.

## 5. Owner actions, in order

1. **Close F-02 now**: Supabase → deploi-prod → Authentication → Providers → Email → turn off new sign-ups; check `profiles` for staff you did not create (production has 3 staff profiles, `STAFF_EMAILS` lists 2).
2. **Review PR #16**, then apply migrations on **preview** (`bhddgjcefwasdyrrfptc`) first:
   - `npx tsx scripts/launch-migrations.ts dry-run --set=2026-11-04 --http=<ref> --confirm-production=<ref>`
   - then `apply`
   - then the same two steps with `--set=2026-11-05`.

   Production after that.
3. **Vercel hygiene**: delete the hex-named preview variable and rotate what it held; rotate the Shopify dev secret; set `CREDENTIALS_ENCRYPTION_KEY` and `CREDENTIALS_KEY_ID` on Production.
4. **One live Commerce run**: a Shopify development store (`docs/SHOPIFY-SETUP.md` §2) or an HTTPS WooCommerce store; plus a Resend-verified `AGENT_MAIL_DOMAIN` (`docs/EMAIL-SETUP.md`); import a real PO CSV and run the Supplier Coordinator with your own address as the supplier.
5. **One live Office run**: a HubSpot public app and test portal, plus a Google OAuth client (`docs/OFFICE-SETUP.md`), with `EMAIL_LIVE_SENDS=allowlist` and `EMAIL_TEST_RECIPIENTS=<you>`.
6. **QuickBooks**: an Intuit developer app and sandbox company (`docs/QUICKBOOKS-SETUP.md`).
7. **Stripe**: test-mode prices for the plans you approve (set `PRICING_APPROVER_EMAILS`); webhook to `/api/billing/stripe/webhook`.
8. **Counsel**: work through `docs/legal/REVIEW-CHECKLIST.md`, then set `LEGAL_GATE=enforce`.
9. **Operations**:
   - confirm the Supabase plan and point-in-time recovery, and run `scripts/restore-rehearsal.sh` against a production copy;
   - wire uptime checks and log drains (`docs/MONITORING.md`);
   - set `AI_PROVIDER` only when an AI-backed step is approved.
