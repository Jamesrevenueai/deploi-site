# Deploi readiness: 2026-11-05, end of "complete everything within your control"

Branch `claude/deploi-operating-system`, draft PR #16. F-02 hotfix: branch `claude/hotfix-f02-signup`, draft PR #17.

**Not merged and not deployed.** Production runs `main` @ e7d2b6c with migrations through 035. This was rechecked read-only today:
- `_migrations` ends at `20261030000035`;
- `disable_signup` is `false`.

No migration on either branch has been applied to a real database.

Status labels:
- **Implemented**
- **Locally tested**: automated tests against local Postgres, synthetic providers and fake HTTP layers that check request shapes, plus browser tests against a production build.
- **Live-tested**
- **Deployed**
- **Blocked**
- **Not implemented**

**Nothing is Live-tested and nothing is Deployed.** This environment has no credentials for any of these: Shopify, WooCommerce, Resend, HubSpot, Google, Microsoft, QuickBooks or Stripe.

## 0. F-02: do this first (production is exposed today)

Anyone can sign up to `deploi-prod` and make themselves staff. Staff can read every organization.

The containment steps are in `docs/HOTFIX-F02.md`:

1. Supabase → `deploi-prod` → Authentication → Sign In / Providers → turn off **Allow new users to sign up**. This closes the hole at once.
2. Run the audit query in `HOTFIX-F02.md` to find profiles that used the hole. Production has 3 staff profiles, but `STAFF_EMAILS` lists 2.
3. Paste `docs/hotfix/F02-hotfix.sql` into the SQL editor and run it. It is one transaction, idempotent, and changes no rows.
4. Merge PR #17 to deploy the one-line app change.
5. Optionally turn sign-ups back on.

Rollback: `supabase/rollback/20261031000001_signup_trust_hotfix.down.sql`, for emergencies only, because it reopens the hole.

## 1. Test evidence (head of the branch)

| Check | Result |
|---|---|
| Unit + integration (`npx vitest run`) | **956/956**, 134 files |
| Browser tests against `next build` | **63/63**: 55 in the main run, plus 8 run with the test billing env against a fake Stripe and placeholder Shopify keys (`E2E_BILLING=1`) |
| Customer journey (`e2e/journey.spec.ts`) | passes; the 10 steps are in §3 |
| Typecheck / lint / production build | clean / 0 errors / succeeds |
| Website (`npm test`, `npm run build`) | 62/62; the build succeeds |
| Forbidden-name scan | clean |
| Release rehearsals 2026-11-04, 2026-11-05, 2026-11-06 | all pass. Each shows: the production host is refused; a dry run leaves nothing; apply keeps existing rows; the app suite passes on the migrated copy (177 / 177 / 268 tests); rollback refuses while data exists or while a later set is applied; `--discard-data` restores the schema byte for byte; re-apply works |
| App rollback compatibility (`scripts/test-app-rollback-compat.sh`) | `main` passes 298/298 on a database with every migration through 057 |
| Constraint overlap 052–057 | none: these migrations only add tables and columns, and redefine no constraint |

## 2. What was completed

| Area | Status | Where |
|---|---|---|
| F-02 hotfix | Locally tested, with each attack reproduced; PR #17 | `docs/HOTFIX-F02.md` |
| Every agent through the Resolution Engine (Engine, Library, Competitor, Supplier adapters) | Locally tested | migration 052, `lib/*/case-sync.ts` |
| Shopify privacy webhooks (F-07): `customers/data_request` exports everything held for that customer, encrypted, for the merchant to download; `customers/redact` and `shop/redact` erase; coverage is catalog-driven over every table | Locally tested; live **Blocked** | 052, `lib/privacy/*`, `tests/privacy/*` |
| System mailer: idempotent; held unless `EMAIL_LIVE_SENDS` allows; single-use links removed from the stored copy | Locally tested; live **Blocked** (Resend domain) | 053, `lib/email/system.ts` |
| Member invites by email (send, resend, revoke, accept as a new or existing user; the link works once) | Locally tested (e2e) | `e2e/account.spec.ts` |
| Sign-up → `/start` → one setup path → first run; Help menu, support requests, contact form | Locally tested (e2e) | `/store/setup`, `/store/support` |
| Billing notices and operations alerts now go out through the system mailer, one send per notice, alert or recipient. Held mail is reported as held. *New today* | Locally tested | `lib/billing/notify.ts`, `lib/ops/notify.ts` |
| Gmail and Outlook inbox reading, after an explicit per-agent grant | Locally tested; live **Blocked** | 054, `lib/email/readers/*` |
| Deploi mailbox new-sender policy: the first reply needs owner or admin approval, which then trusts the sender | Locally tested | `lib/email/sender-policy.ts` |
| Integration hub: test / reconnect / disconnect; hourly health probes with backoff; diagnostics; validation; Office provider-call metering | Locally tested (e2e) | 055, `lib/integrations/*` |
| Billing lifecycle: trial without a card, dunning with a grace period then read-only, upgrade with Stripe's preview, cancel at period end with a reason, reactivate, Shopify-billed merchants routed to Shopify, finance reporting | Locally tested against fake Stripe; live **Blocked** | 056, `lib/billing/*`, `e2e/billing.spec.ts` |
| Operations: alert rules (queue, dead jobs, crons, connection health, budgets); staff console with switches, queue, alerts, case search and logs; AI-assisted steps with a deterministic fallback | Locally tested (e2e) | 057, `lib/ops/*`, `/staff/ops` |
| Release set `2026-11-06` and its rehearsal. *New today* | Locally tested | `scripts/launch-migrations.ts`, `scripts/test-release-2026-11-06-migrations.sh` |

### Defects found and fixed today

- **Supplier replies.** "Only 6 now, the rest go out in full by Nov 20" was read as the order confirmed in full. It is now read as a split delivery: short lines are marked partial, and the supplier is asked to confirm each shipment unless the rest is plainly backordered or unavailable.
- **Approved reminder in quiet hours.** An approved reminder held by quiet hours or the daily limit left its case at "awaiting approval", with "Approve or decline" as the next step. The case now moves to sending, with the real reason and the send time.
- **Office approval cards.** They showed internal ids, metadata and machine names (`send_email`, policy version, UUIDs) around the message. They now show the recipient, subject and body, then the purpose. The approval is still bound to the hash of the whole payload.
- **Duplicate evidence.** The case page repeated the same QuickBooks observation. It is now shown once.
- **Privacy catalog.** The account, support and system-mail tables were missing from it. They are now classified, each with its reason.
- **Expired privacy exports.** They were deleted only when another privacy request arrived. The daily retention job now deletes them.

## 3. The customer journey (one browser run, a brand-new account)

1. Sign up: the new user owns a new organization.
2. Name the business.
3. Choose Deploi Office.
4. Connect synthetic QuickBooks and a synthetic mailbox.
5. Discovery finds the overdue invoice.
6. Set up the recommended team at drafts only and grant it. At drafts only nothing is sent.
7. Widen the agent to "After my approval". This creates a new version, which is granted. Then read the exact reminder and approve it.
8. The customer pays in QuickBooks, simulated by a Payment on the synthetic company.
9. The case appears in Completed Work as **Resolved and verified**. The evidence is the fresh QuickBooks read (balance 0) and the payment.
10. Billing, member invitation, Integrations and Privacy pages.

Screenshots at 1440 and 390 px: `proof/journey-*`.

## 4. Real-service readiness, per integration

| Integration | Built and tested locally | Needed for a live run |
|---|---|---|
| Shopify | OAuth, webhooks (HMAC), privacy webhooks, embedded app (session tokens, App Bridge), scans and writes with a fresh-read check | Partner app, dev store, `SHOPIFY_API_KEY/SECRET` (rotate the dev secret first) |
| WooCommerce | REST keys, HTTPS only, scans and writes with verification | An HTTPS test store and keys |
| HubSpot | OAuth, contacts, deals, commitments as cases | A public app and a test portal |
| Google Calendar / Gmail | OAuth, freebusy, booking verified by read-back, inbox reading after a grant | A Google OAuth client with verified scopes |
| Outlook | Graph OAuth, inbox reading, reply detection | An Entra app registration |
| QuickBooks Online | OAuth bound to `realmId`, rotating refresh, signed webhook, read-only client, AR agent | An Intuit developer app and sandbox company |
| Deploi Email (Resend) | Agent mailboxes, inbound, system mail, `EMAIL_LIVE_SENDS` gate | A verified `AGENT_MAIL_DOMAIN` and `RESEND_API_KEY`; start with `allowlist` |
| Stripe | Checkout, portal, webhooks, trial, dunning, plan changes, cancellation | Test-mode prices for **owner-approved** plans. Pricing stays a hypothesis until `PRICING_APPROVER_EMAILS` approves it |

## 5. Production readiness

- **Security.**
  - F-02 is open in production until §0 is done.
  - On the branch, no critical finding is known to be open. RLS, tenant-isolation, credential and route sweeps are catalog-driven and pass.
  - Preview hygiene is still open: a Vercel variable named with a 32-hex string, and a Shopify dev secret marked "rotate".
- **Deployment.**
  1. §0.
  2. Apply sets 2026-11-04, 2026-11-05 and 2026-11-06 to **preview** (`docs/RELEASE-RUNBOOK.md` §1), smoke-test the preview, then do the same on production.
  3. Merge PR #16.
- **Rollback.**
  - App: promote the previous Vercel deployment. This is proven safe on the new schema.
  - Database: roll back set by set, newest first. The tool refuses any other order.
- **Monitoring.** The health endpoint, alert rules and the staff ops console are built. Uptime checks, the log drain and `CRON_SECRET` need the owner (`docs/MONITORING.md`).
- **Billing.**
  - `BILLING_MODE` stays off until Stripe is configured.
  - No customer is charged until the owner approves prices and turns billing on.

## 6. Owner actions (what, where, why)

1. **§0 F-02 containment.** In the Supabase dashboard, then the SQL editor, then merging PR #17. It closes a live privilege escalation.
2. **Review PR #16** and apply the three sets on preview (runbook §1). Nothing reaches production untested.
3. **Vercel → deploi-app → Settings → Environment Variables.**
   - Delete the hex-named preview variable and rotate what it held.
   - Rotate the Shopify dev secret.
   - Set `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID` and `CRON_SECRET` on Production. They are required for stored tokens and the job worker.
4. **Resend.** Verify `AGENT_MAIL_DOMAIN` and the system mail domain, then set `RESEND_API_KEY` and `EMAIL_LIVE_SENDS=allowlist` with `EMAIL_TEST_RECIPIENTS=<you>`. Invites, billing notices, alerts and agent mail are held until then.
5. **One live Commerce run** (Shopify dev store or WooCommerce) and **one live Office run** (QuickBooks sandbox + HubSpot/Google). These promote features from "Locally tested" to "Live-tested". Guides: `docs/SHOPIFY-SETUP.md`, `docs/OFFICE-SETUP.md`, `docs/QUICKBOOKS-SETUP.md`, `docs/EMAIL-SETUP.md`.
6. **Stripe.** Approve prices, create test-mode prices and set the webhook to `/api/billing/stripe/webhook`. This turns on trials and subscriptions.
7. **Counsel.** Work through `docs/legal/REVIEW-CHECKLIST.md`, then set `LEGAL_GATE=enforce`. The legal pages are drafts.
8. **Operations.**
   - Confirm point-in-time recovery and run `scripts/restore-rehearsal.sh` on a production copy.
   - Set up the uptime checks and log drain.
   - Set `AI_PROVIDER` only when an AI-assisted step is approved.

## 7. Remaining limitations

- Nothing is live-verified. Every provider path runs against synthetic providers or fake HTTP layers that check request shapes.
- Re-registering Shopify webhooks may briefly produce duplicate deliveries. They are deduplicated by webhook id, so this is noise, not double processing.
- Store-agent mailboxes still quarantine new senders. Office's first-contact approval does not apply to them yet.
- In the Inbox, a Gmail or Outlook thread can be read and released, but not replied to directly by a person.
- Enquiries from the website contact form are personal data of prospects. Erasure is a manual staff step.
- The billing and embedded-Shopify browser tests need the test env shown in §1, and do not run by default.

## 8. PR #16 preview environment (set up 2026-11-05, 22:00–22:50 UTC)

The goal was a working PR #16 preview with demo data. **Production was not touched.** The preview is **not yet usable for the core flows**: see 8.5.

### 8.1 Configuration
- **Preview database:** Supabase **deploi-preview** (`bhddgjcefwasdyrrfptc`), synthetic data only. It was confirmed to be preview, not deploi-prod (`makqaqzlylhckijdbjzi`), before every change.
- **Migrations:** the F-02 hotfix, then release sets 2026-11-04, 2026-11-05 and 2026-11-06, each dry-run first. There are 48 recorded and the latest is `20261106000057_operations.sql`.
- **Database login:** `deploi_pr16_app`, used only by this preview. It has BYPASSRLS and membership of `service_role`, `authenticated` and `anon`. It cannot write `auth.users`, because Supabase reserves that table for its own internal role.
- **Vercel variables:** 8 variables on deploi-app, Preview only, branch `claude/deploi-operating-system`. Read back by name and scope; none is Production or Development.

  | Name | Type |
  |---|---|
  | DATABASE_URL | sensitive |
  | CREDENTIALS_ENCRYPTION_KEY | sensitive |
  | CREDENTIALS_KEY_ID | plain |
  | DEMO_CONTROLS | plain |
  | EMAIL_LIVE_SENDS=off | plain |
  | AGENT_MAIL_DOMAIN | plain |
  | NEXT_PUBLIC_APP_URL | plain |
  | AI_PROVIDER=off | plain |

  The two secrets were generated in a single shell process and sent straight to Supabase and Vercel. They were never printed, logged or written to a file.
- **Build rule:** `deploi-app/vercel.json` used to skip a forced rebuild of an unchanged commit. Commit `2d4bab5` makes such a rebuild always run; a push with no change under `deploi-app/` is still skipped. All three cases were tested locally.
- **Preview build:** `dpl_dj1m6t4gmV3DL5WV2NfPzie7F7xE`, commit `2d4bab5`, READY. The preview runs at https://deploi-app-git-claude-deploi-operating-system-james-ai.vercel.app and needs a Vercel login.
- **Database health:** `/api/health` reports `db.reachable: true`. The preview connects as `deploi_pr16_app`, seen in `pg_stat_activity` through the Supabase pooler.

### 8.2 F-02 on the preview database (sign-up trigger tested directly; all rolled back, 0 rows left)

| # | Case | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | User metadata `{role: staff, agency_id: Northwind}` | client, no org | client, no org | PASS |
| 2 | User metadata `{role: admin, is_admin, is_staff, tenant_id, org_id, org_role: owner}` | client, no org | client, no org | PASS |
| 3 | User metadata `{role: service_role, agency_id: Harbor}` | client, no org | client, no org | PASS |
| 4 | A prefix of a staff address | client | client | PASS |
| 5 | A staff address embedded in a longer one | client | client | PASS |
| 6 | The exact staff address (positive control) | staff | staff | PASS |
| 7 | Server-set app metadata assigns Northwind | client, Northwind | client, Northwind | PASS |
| 8 | An invited address with user metadata asking for staff | client, no org | client, no org | PASS |
| 9 | Sign-up alone does not accept the invitation | not accepted | not accepted | PASS |
| 10 | F-01/F-03: `leads` select and `staff_email_list()` execute for anon/authenticated | all false | all false | PASS |
| 11 | The trigger in force reads app metadata only | app yes, user no | app yes, user no | PASS |

**11/11 passed.**

### 8.3 Browser checks on the preview (demo accounts; 1440 and 390 px; screenshots in `proof/preview-pr16/`)

| Check | Result | Exact error / evidence |
|---|---|---|
| 8.1 Demo sign-in (Northwind owner → Home) | PASS | `01-home-1440.png`, `01-home-390.png` |
| 8.2 New sign-up, then login | **Not testable on this preview** | `permission denied for table users` (42501): see 8.4 |
| 8.3 Demo data (Office on, synthetic QuickBooks and mailbox, a scan, a demo case) | FAIL | `(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15` (`POST /login`, digest 2860882568) |
| 8.3b Second demo account (Harbor) sees only its own organization | PASS | `03b-harbor-home-1440.png`, `03b-harbor-home-390.png` |
| 8.4 Control Room shows the work waiting | FAIL | the same EMAXCONNSESSION error (`GET /login`, digest 3982788768) |
| 8.5 AI Team: discovery and the recommended team | FAIL | the same EMAXCONNSESSION error (digest 3982788768) |
| 8.6 Approve the demo case → Completed Work, verified | FAIL | the same EMAXCONNSESSION error (digest 3982788768) |
| 8.7 Inbox | FAIL: **check-script error, not an app result** | the script opened `/store/messages`, which doesn't exist (404), then looked for the navigation rail there. The check has to be rerun. |
| 8.8 Integrations: every tool with an honest status | PASS | `08-integrations-1440.png`, `08-integrations-390.png` |
| 8.9 Agent workflow: an Office agent drafts | FAIL | the same EMAXCONNSESSION error (digest 2860882568) |

**Totals:** 3 pass, 5 fail on the connection limit, 1 inconclusive (script error), and 1 not testable.

**Demo data:** none was created, because the seeding check failed at sign-in. Row counts before and after the run were identical:

| Table | Rows |
|---|---|
| agencies | 2 |
| profiles | 4 |
| org_products | 2 |
| store_connections | 2 |
| agents | 4 |
| office_connections, email_accounts, office_agents, office_agent_policies, discovery_runs, discovery_agents, business_profiles, issues, proposals, approvals, cases, case_events, case_links, office_invoices, office_actions, connection_health, engine_audit, jobs | 0 each |

### 8.4 Why browser sign-up can't be tested here (read-only analysis; nothing changed)
- **Production** runs with `AUTH_MODE` unset and `resolveAuthMode` forces `supabase` (`lib/auth-guard.ts:45-46`).
  - Sign-up is the magic-link form (`app/login/actions.ts:56-66`). It calls `sb.auth.signInWithOtp` through `@supabase/ssr` with the **anon key** (`lib/supabase/server.ts:8`).
  - The **Supabase Auth service (GoTrue)** creates the `auth.users` row as its own role. The app's Postgres login doesn't create it, and the service-role key isn't used for it.
  - The trigger `on_auth_user_created` then runs `handle_new_user` to create the profile (`supabase/migrations/20261020000001_foundation.sql:529`, replaced by the hotfix `20261031000001`).
  - The session is created at `app/auth/callback/route.ts:19`, and a missing profile is built from `app_metadata` only (`lib/auth.ts:83`).
- **This preview** has `AUTH_MODE=dev` and `ALLOW_DEV_LOGIN=true`, and no anon key: `NEXT_PUBLIC_SUPABASE_ANON_KEY` is Production-only.
  - So sign-up goes through `devSignUp` (`app/login/actions.ts:42-54`), then `devAccountFor`, which writes the row directly as the app's database login: `insert into auth.users` (`lib/platform/dev-accounts.ts:17`).
  - **This is a different path from production.** It shares only the trigger, which 8.2 tests directly.
- **Smallest change to make browser sign-up testable on this preview** (not made): give the preview a database login that is allowed to write `auth.users`. That means pointing the branch's `DATABASE_URL` at the preview project's `postgres` login, after the owner resets that password in Supabase.
  - This needs no code change.
  - Testing production's actual magic-link path would also need the preview's anon key, `AUTH_MODE=supabase`, and real email delivery. That sends real email, so it needs approval.

### 8.5 The connection-limit failure: cause and proposed fix (not made)
- **Cause:** `DATABASE_URL` points at the Supabase pooler in **session mode** (port 5432), which allows **15 clients** for this project. Each Vercel function instance keeps up to 8 connections open (`lib/db.ts:26`, `max: 8`), so two or three warm instances use them all up. Requests then fail on `/login` and the store APIs.
- **Proposed fix:** switch the branch's `DATABASE_URL` to **transaction mode** (same host, port 6543), and/or lower `max` for serverless. The app's per-request `set local` statements work in transaction mode.
  - Doing this means writing a new `DATABASE_URL`. It's a sensitive variable whose value can't be read back, so the password would be regenerated the same way as before.
  - It needs the owner's go-ahead.

### 8.6 Production, read-only, before and after this work
- Deployment `dpl_9B3Xf6FmBfnvBqNVhqPBQywDPvYd` (commit e7d2b6c) both times.
- Production-scoped variable names were the same 9 both times: APP_SECRET, CRON_SECRET, DATABASE_URL, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL, PUBLIC_API_ALLOWED_ORIGINS, STAFF_EMAILS, SUPABASE_SERVICE_ROLE_KEY.
