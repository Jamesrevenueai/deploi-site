# FINISH LEDGER (single source of truth for the 2026-11-22 finish run)

Branch: `claude/tender-pascal-0fax6x` (this session's branch). It starts at `4f52669` (tip of `claude/sleepy-dirac-wulfpe`,
which contains `claude/reviewer-store-mode` @ `97dbf69`) plus this run's commits. Secrets: **names only**, never values.

| Step | Status | Proof |
|---|---|---|
| 1 Branch + PR inventory | done | §1 |
| 2 Commit graph | done | §2 |
| 3 Feature status table | done | §3 |
| 4 Vercel config + flags | done | §4 |
| 5 Domain → deployment map | done | §5 |
| 6 One PR to main | done, PR open (not merged: gate) | §6 |
| 7 Full suites green | **done: all green** (76/76 e2e incl. billing; 1,382/1,382 unit) | §7, §12 |
| 8–9 Store agents live on james-jwtftl1e | **blocked** | §8 |
| 10 Shopify readiness | done (code); founder clicks remain | §10 |
| 11 `docs/SHOPIFY_PROD_APP.md` | done | file |
| 12 `docs/SHOPIFY_LISTING.md` + screenshots | done (drafts; final from the dev store after step 5 of FOUNDER_ACTIONS) | file, `docs/listing-screenshots/` |
| 13 Office PARTIAL items | partly (see §3 after) | §3 |
| 14 Missed Call + Booking agents | done, behind flag off | §9 |
| 15 Service-business sign-up + Office section | done, behind flag off | §9, screenshots |
| 16 Office end-to-end with test accounts | done on synthetic ports + simulated SMS (`tests/packs/phone.test.ts` chain test); live run blocked on a Twilio account | §9 |
| 17 Flag what is not fully working | done | §9 |
| Gate (Part 4) | **NOT MET**: (a), (b), (d) false | §11 |
| 18–21 Production ship | **not run** (gate) | §11 |

## 1. Branches (25 remote) and open PRs

Newest commit across all branches: **`4f52669`** (2026-11-22, `claude/sleepy-dirac-wulfpe`). `main` = `e7d2b6c` (2026-10-30).
"In newest" = contained in `claude/sleepy-dirac-wulfpe`.

| Branch | SHA | Date | Merged to main | In newest |
|---|---|---|---|---|
| `claude/sleepy-dirac-wulfpe` | 4f52669 | 2026-11-22 | N | Y |
| `claude/reviewer-store-mode` | 97dbf69 | 2026-11-18 | N | Y |
| `claude/deploi-platform-launch` | aaadc4d | 2026-11-17 | N | Y |
| `claude/sleepy-heisenberg-ahsi2p` | 6c5d81d | 2026-11-10 | N | Y |
| `claude/deploi-operating-system` | 6024a3f | 2026-11-06 | N | Y |
| `claude/hotfix-f02-signup` | 701648c | 2026-11-05 | N | Y |
| `claude/overnight-automation-tasks-8f1257` | 8c3e652 | 2026-11-01 | N | N: its one test file carried over in this run; its docs are superseded (old DNS plan, draft screenshots) |
| `claude/tender-pascal-0fax6x` | e7d2b6c → this run | 2026-10-30 | Y | Y |
| `main` | e7d2b6c | 2026-10-30 | Y | Y |
| `claude/agents-first-embedded-preview` | 396766b | 2026-10-30 | Y | Y |
| `claude/jolly-ptolemy-kp7ljd` | bfe65a9 | 2026-10-30 | N | N: superseded (Oct live-evidence line; uninstall/compliance features re-landed and tested) |
| `claude/fervent-goldberg-hjazil` | f324f30 | 2026-10-30 | Y | Y |
| `subscription-product` | bfa1d49 | 2026-10-30 | Y | Y |
| `claude/launch-proof` | 531b569 | 2026-10-30 | N | N: one proof screenshot commit, superseded |
| `claude/prod-runbook` | 602c771 | 2026-10-30 | Y | Y |
| `claude/launch-ops` | a91c607 | 2026-10-30 | Y | Y |
| `claude/replay-pr6-pr4` | c7b73c2 | 2026-10-30 | Y | Y |
| `claude/platform-launch` | e8e1114 | 2026-10-30 | N | N: superseded (bounce handling, entitlements, honeypot, uninstall-pause all present in newest) |
| `claude/agents-platform` | 2466339 | 2026-10-29 | N | N: superseded (competitor watcher present: 80 files) |
| `claude/retire-consulting` | 998bfe1 | 2026-10-30 | N | N: superseded (consulting removal enforced by `src/__tests__/pages.test.tsx`) |
| `claude/aurora-agent-library` | a3c3d08 | 2026-10-29 | N | N: superseded |
| `backup/platform-launch-9bd7b24` | 9bd7b24 | 2026-10-29 | N | N: a backup |
| `claude/prod-auth-guard` | 3419c2e | 2026-10-28 | N | N: superseded (dev auth refused in production, 35 files) |
| `feat/app-supabase-auth` | f203943 | 2026-10-22 | N | N: superseded |
| `feat/site-app-buttons` | b36280d | 2026-10-22 | N | N: superseded |

Open PRs (Jamesrevenueai/deploi-site): #20 (sleepy-dirac-wulfpe → main, draft), #19 (reviewer-store-mode → #18, draft),
#18 (deploi-platform-launch → main), #15 (overnight, draft), #10 (launch-proof, draft), #2 (prod-auth-guard, draft).
This run's PR supersedes #18, #19 and #20 (it contains all three). Nothing was closed or deleted.

## 2. Commit graph (linear: no merge conflicts possible)

```
* 4f52669 (sleepy-dirac-wulfpe)   Proof 2026-11-22: live production before the ship
* 97dbf69 (reviewer-store-mode)   Click list ... production on review
* aaadc4d (deploi-platform-launch) Tests: three order-dependent tests made independent
* 6c5d81d (sleepy-heisenberg)     Phase 1 audit
*   ...                            (9441dff  Site: date the operator config  <- deploi-site PRODUCTION)
* 6024a3f (deploi-operating-system)
* 701648c (hotfix-f02-signup)
* e7d2b6c (main)                  Merge PR #14   <- deploi-app PRODUCTION
```
`git merge-base --is-ancestor origin/main origin/claude/sleepy-dirac-wulfpe` → true, `main` is 0 commits ahead.
So the merge is a fast-forward: **0 conflicts**, and no fix on main can be undone.

## 3. Feature status (before → after this run)

Legend: WORKING = runs against the real platform it needs and is tested. PARTIAL = built and tested, but on synthetic or
fake-HTTP data, or a piece is missing. NOT BUILT.

### Store agents
Only the three correction-engine templates touch a real Shopify store (`lib/agents/templates.ts` via
`lib/connectors/shopify/connector.ts`). The library runners read through `lib/library/store-data.ts`, which on a real store
is `liveStoreDataStub()` (refuses with `not_wired`). The commerce pack's live Admin GraphQL path (`lib/commerce/pack/live-store.ts`)
is tested only against a fake GraphQL layer. Several agents also need protected customer data scopes, which this first
submission deliberately does not request.

| Agent | Before | After | Why / proof |
|---|---|---|---|
| Inventory Watcher | WORKING | WORKING | engine template writes `inventoryPolicy`; tests/shopify/detection, e2e/platform "Inventory Watcher: drafts…" |
| Store Health Checker | WORKING (read-only) | WORKING | engine template; e2e/platform |
| Supplier Chaser | PARTIAL | PARTIAL | reads real stock; restock email held until `EMAIL_LIVE_SENDS` + Resend (gate d) |
| Listing Writer | PARTIAL | PARTIAL | pack `setDescription` fake-tested (pack-live test); library stub |
| AI Visibility | PARTIAL | PARTIAL | pack `setSeoDescription` fake-tested |
| Promo Manager | PARTIAL | PARTIAL | needs `write_discounts` (not an install scope) |
| Campaign | PARTIAL | PARTIAL | drafts only |
| Order Tracker | PARTIAL | PARTIAL | needs `read_orders` (protected data level 2) |
| Returns | PARTIAL | PARTIAL | needs returns/orders writes (level 2) |
| Customer Care | PARTIAL | PARTIAL | needs `read_orders` (level 2) and a mail path |
| Weekly Insights | PARTIAL | PARTIAL | needs `read_orders` (level 1) |
| Payout & Fees Checker | PARTIAL | PARTIAL | needs `read_shopify_payments_payouts` |

Not changed in this run, on purpose. Finishing the 9 PARTIAL store agents means: (1) protected-customer-data approval
from Shopify for the order/return/customer agents, (2) wiring `live-store.ts` into the library store-data, and (3) proving it
on james-jwtftl1e. (3) is blocked (§8), and shipping (2) untested into the review build would put unproven writes in front
of Shopify reviewers. They stay hidden inside Shopify (`shopifyLibraryAgentKeys()` is empty; tests/shopify/embedded-gating).

### Platform (all WORKING before and after, unless noted)
| Feature | Status | Proof |
|---|---|---|
| Custom agent builder | WORKING | lib/library/custom.ts, lib/agents/parse.ts; e2e/agents "the wizard refuses a vague task…" |
| Library enable/disable | WORKING | lib/library/switches.ts; tests/library/switches, permissions "a switched-off agent does not run…" |
| Per-agent dashboard: text chat, standing instructions | WORKING | lib/app/feeds.ts, lib/app/control.ts; tests/app redesign, e2e/agent-dashboard |
| Per-agent dashboard: **voice** chat | PARTIAL | browser Web Speech only (components/team/useVoice.ts); only the no-speech fallback is tested |
| Command center (Store/Office switch, Needs you, Done with proof) | WORKING | lib/app/feeds.ts `commandCenter`; e2e/work |
| Least-privilege grants | WORKING | lib/engine/authorize.ts; tests/infra/authorize, merchant/scopes |
| Autonomous detection | WORKING (packs on synthetic data) | vercel.json crons (sweep 15 min), Shopify webhooks → lib/events; tests/autonomy/router |
| Weekly time-saved summary | WORKING (email held until live sends) | lib/agents/weekly.ts; merchant/platform "weekly summary…" |
| Tier gating | WORKING | lib/library/pricing.ts; tests/library/tiers, e2e/team |
| GDPR webhooks | WORKING | lib/connectors/shopify/compliance.ts; tests/shopify/webhooks, privacy/customer-privacy |
| Uninstall pauses agents | WORKING | install.ts; security/queued-work, merchant/shopify-routes |
| Reviewer store mode | WORKING | lib/engine/access.ts; merchant/access, merchant/review-mode-agents |

### Office
| Item | Before | After | Proof / what is missing |
|---|---|---|---|
| Outlook mail | PARTIAL | PARTIAL | real Graph client, fake-HTTP tested; needs an Entra app (FOUNDER_ACTIONS B6) |
| Outlook calendar | PARTIAL | PARTIAL | client exists; pack ports are synthetic (`setPortsFactory` never called); meeting scheduler is Google-only |
| CRMs: HubSpot (agents read/write), Salesforce, Pipedrive, Zoho, Buildium (polling) | PARTIAL | PARTIAL | real OAuth/API, fake-HTTP tested; no live sandbox |
| QuickBooks | PARTIAL | PARTIAL | reads + webhook real; pack invoicing port synthetic |
| Owner SMS + voice with links | PARTIAL (simulated only) | **PARTIAL+**: live Twilio adapter built (held unless `NOTIFY_LIVE_SENDS=on`, test mode limits sends to `NOTIFY_ALLOWED_NUMBERS`) | lib/notify/twilio.ts; tests/packs/phone "Twilio adapter guard" (2). Live run needs a Twilio account |
| Field crew dispatch | PARTIAL | PARTIAL+: crew can now text DONE to the business line | phone chain test step 7 |
| Invoicing + payment follow-up | PARTIAL | PARTIAL | synthetic invoicing port |
| Leasing commission invoicing | PARTIAL | PARTIAL | synthetic |
| **Missed Call Agent** | NOT BUILT | **built, flag off** | lib/packs/phone.ts; tests/packs/phone (16 tests) |
| **Booking Agent** | NOT BUILT (email booking only) | **built, flag off** | same |
| Service-business sign-up | NOT BUILT | **built, flag off** | /service-businesses, /api/public/office-signup; tests/api/office-signup (3), site service-businesses (4) |

## 4. Vercel configuration (team JamesAi, read 2026-11-22)

| | deploi-app `prj_Wxz1h5poVT6woqvjt66Cl7KFyL6v` | deploi-site `prj_Xb6Vx6VaNR5c4UKboR52N2hDIq1v` |
|---|---|---|
| Framework | nextjs (Node 24.x) | vite |
| Production deployment | `dpl_9B3Xf6FmBfnvBqNVhqPBQywDPvYd`, main @ e7d2b6c (2026-10-31) | `dpl_3VocEzdHgSm9a1w6Eghmdiiogri3`, **claude/deploi-platform-launch** @ 9441dff |
| Production branch | main (every production deployment is from main) | not readable through the API token available here (team scope refused). Its production came from a non-main branch, so it was promoted or deployed by hand |
| Root dir / build | `deploi-app` per repo `vercel.json` files; build `next build` | repo root; `tsc --noEmit && vite build` |

**deploi-app env names**
- **Production**:
  - `STORE_ACCESS_MODE` (=review)
  - `CREDENTIALS_KEY_ID` (=prod-k1)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`
  - `NEXT_PUBLIC_APP_URL`, `STAFF_EMAILS`, `PUBLIC_API_ALLOWED_ORIGINS`
  - `NEXT_PUBLIC_SUPABASE_URL`, `CRON_SECRET`, `APP_SECRET`
- **Preview (all branches)**:
  - `SHOPIFY_API_SECRET`, `APP_SECRET`
  - `NEXT_PUBLIC_SUPABASE_URL`, `DATABASE_URL_POOLED`
  - `NEXT_PUBLIC_APP_URL`, `STAFF_EMAILS`, `PUBLIC_API_ALLOWED_ORIGINS`, `CRON_SECRET`
- **Preview, branch `claude/deploi-platform-launch`**:
  - `DEVSTORE_ADMIN_TOKEN` (marked temporary)
  - `SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, `SHOPIFY_API_VERSION`
  - `AI_PROVIDER`, `NEXT_PUBLIC_APP_URL`, `AGENT_MAIL_DOMAIN`, `EMAIL_LIVE_SENDS`, `DEMO_CONTROLS`
  - `CREDENTIALS_KEY_ID`, `CREDENTIALS_ENCRYPTION_KEY`
- **Preview, branch `claude/deploi-operating-system`**: `CREDENTIALS_ENCRYPTION_KEY`, `DEMO_CONTROLS`, `EMAIL_LIVE_SENDS`, `AGENT_MAIL_DOMAIN`, `NEXT_PUBLIC_APP_URL`, `AI_PROVIDER`

**deploi-site env names:** `VITE_APP_API_URL` (Production + Preview), `VITE_FORMSPREE_ENDPOINT` (Production).

**Flags checked:**
- `AUTH_MODE`, `ALLOW_DEV_LOGIN`, a bypass flag or `DEMO_CONTROLS` in Production: **none** ✓
- `CREDENTIALS_ENCRYPTION_KEY` in Production: **missing** ✗ (only the two branch-scoped Preview copies)
- Leftover `jolly-ptolemy` variables: **none** ✓ (removed 2026-11-17)
- Stale branch-scoped Preview sets remain for `claude/deploi-operating-system` (PR #16 era) and `claude/deploi-platform-launch`. Harmless to production. Left in place (no deletions per the rules).

## 5. Domains → deployments

| Domain | Project | Serves |
|---|---|---|
| app.getdeploi.com | deploi-app | production `dpl_9B3Xf6FmBfnvBqNVhqPBQywDPvYd` (e7d2b6c) |
| deploi-app.vercel.app | deploi-app | same production |
| dev.getdeploi.com | deploi-app, git branch `claude/deploi-platform-launch` | newest READY preview of that branch: `dpl_7ATQNtdPdDGSwqWzg3oYE2VsZPuJ` (aaadc4d) |
| getdeploi.com | deploi-site | production `dpl_3VocEzdHgSm9a1w6Eghmdiiogri3` (9441dff) |
| www.getdeploi.com | deploi-site | 308 → getdeploi.com |
| gotdeploi.com | deploi-site | 308 → getdeploi.com |

## 6. The PR
One PR from `claude/tender-pascal-0fax6x` into `main`: everything in #18 + #19 + #20 plus this run. Conflicts: **none**
(fast-forward, §2). It is **not merged**: the production gate is not met, and merging to main is the step that ships.

## 7. Test counts
See the table filled in at the end of the run (§12).

Baseline before this run's changes (same machine, local Postgres 16, local production build):
- app unit: **1,356 / 1,356** passed (183 files)
- app typecheck: 0 errors
- app lint: 0 errors, 9 warnings
- app e2e: 67 passed, 1 failed, 5 skipped, 3 did not run (76 total)
  - The 1 failure: `e2e/platform.spec.ts:59` Supplier Chaser expects the agent mailbox domain. My local env lacked
    `AGENT_MAIL_DOMAIN`, which Preview sets. **Environment only, not a code bug.** The 3 "did not run" are the serial
    tests after it.
  - The 5 skipped are `e2e/billing.spec.ts`, which needs `E2E_BILLING=1` and a fake-Stripe server. These are the "5
    failing" in the brief: they were skipped, never failed.
- site: typecheck 0, lint 0, **64 / 64**, build ✓

## 8. Store agents on james-jwtftl1e: BLOCKED
This container has no admin access to the dev store: there is no `DEVSTORE_ADMIN_TOKEN` (only on Vercel Preview), and
`SHOPIFY_SERVICE_ACCOUNT_TOKEN` manages app configuration, not store data. Nothing in the ledger confirms that Deploi (dev)
is installed on james-jwtftl1e. Unblock: FOUNDER_ACTIONS step 5. Then every store agent is run once and its dashboard and
proof entry are screenshotted.

## 9. Track B: what was built, and what is flagged off
- **Flags (all off by default):**
  - `OFFICE_PHONE_AGENTS` (app): agents unlisted, handlers no-op, phone webhooks 404
  - `OFFICE_SIGNUP` (app): sign-up API 404
  - `VITE_OFFICE_SIGNUP` (site): no `/service-businesses` route, no Office-page section
- **Built:**
  - Missed Call Agent and Booking Agent (`lib/packs/phone.ts`)
  - Twilio adapter (`lib/notify/twilio.ts`)
  - Phone webhooks (`/api/webhooks/phone/voice`, `/api/webhooks/phone/sms`)
  - Owner phone-line setting (packs op `phone-line`)
  - Migration **065** + rollback
  - Office sign-up API and site page
- **End-to-end (test accounts, synthetic ports, simulated SMS):** `tests/packs/phone.test.ts` › "the full chain for a
  service business" runs:
  1. missed call → text back (< 60 s, proof recorded)
  2. reply → CRM lead → owner update with `/store/packs/office?lead=…`
  3. three times offered → booked
  4. "reschedule" → old event cancelled → rebooked
  5. reminder the day before (once)
  6. quote → crew dispatched
  7. crew texts DONE to the business line (signed webhook) → invoice created and sent
  8. late → reminder → paid
  9. owner text **and** voice note with the link (real owner pipeline → `notify_outbox`)

  Passes twice in a row.
- **Why it stays off:**
  1. No SMS/voice account. The repo had only a simulated sender, and Twilio needs your account plus US A2P 10DLC registration (FOUNDER_ACTIONS B1).
  2. Calendar, CRM and invoicing for packs are synthetic ports. The real Outlook/HubSpot/QuickBooks clients exist but are not wired into the packs (`setPortsFactory`), and they are not live-verified.
  3. No Office UI screen yet for entering the phone line (the API exists).
  4. Not live-tested with a real phone.

## 10. Shopify readiness (code side)
| Requirement | Status | Proof |
|---|---|---|
| GDPR webhooks answer correctly, HMAC-verified | ✓ | tests/shopify/webhooks, privacy/customer-privacy |
| Uninstall pauses agents | ✓ | security/queued-work, merchant/shopify-routes |
| Session token auth (embedded) | ✓ | e2e/embedded.spec.ts ran in this run with local key/secret (was skipped before) |
| Required scopes only | ✓ | 5 install scopes, no protected data (docs/SHOPIFY_PROD_APP.md §3) |
| Privacy / Terms / Support live, operator named | ✓ HTTP 200 on 2026-11-22 | casing of the LLC name to confirm (FOUNDER_ACTIONS 10) |
| Free pricing | code ✓ (`BILLING_REQUIRED` unset = false); dashboard click remains | FOUNDER_ACTIONS 7 |
| Reviewer store mode | ✓ `STORE_ACCESS_MODE=review` on Production | tests/merchant/access |
| IP allowlist documented | ✓ | docs/SHOPIFY_PROD_APP.md §7 |

## 11. Production gate: NOT MET (nothing was changed in production)
| Condition | Result | Evidence |
|---|---|---|
| (a) `CREDENTIALS_ENCRYPTION_KEY` in Production | **false** | Vercel env list 2026-11-22 |
| (b) Two exposed secrets rotated and confirmed | **false** | no confirmation in FOUNDER_ACTIONS or here; `SHOPIFY_API_SECRET` (Preview) last updated 2026-11-08 |
| (c) Everything green | **true** | §12 |
| (d) Resend DNS verifies | **false** | `resend._domainkey.getdeploi.com` and `send.getdeploi.com` are NXDOMAIN (dns.google) |

Not done because of the gate:
- No production branch change, no env removal or addition, no migration and no deploy.
- Rollback targets stay `dpl_9B3Xf6FmBfnvBqNVhqPBQywDPvYd` (app) and `dpl_3VocEzdHgSm9a1w6Eghmdiiogri3` (site).
- **Pending migrations for production when the gate opens:** 058–064 (from the earlier release plan, applied on
  deploi-preview 2026-11-07) and **065** (this run: phone agents and office sign-up). Back up first
  (`scripts/backup-before-launch.sh`), then list, then apply with `npm run db:migrate:prod`.

## 12. Final numbers (final code, local Postgres 16, local production build, 2026-11-22)

| Check | deploi-app | deploi-site |
|---|---|---|
| Unit | **1,382 / 1,382** passed (186 files; was 1,356 / 183) | **68 / 68** (8 files; was 64) |
| E2E | **71 passed / 0 failed** in the main run + **5 / 5** `billing.spec.ts` on a server in billing test mode with the fake Stripe = **76 / 76** | n/a |
| Typecheck | 0 errors | 0 errors |
| Lint | 0 errors (9 warnings, all pre-existing) | 0 errors |
| Build | `next build` ✓ (new routes: `/api/public/office-signup`, `/api/webhooks/phone/sms`, `/api/webhooks/phone/voice`) | `vite build` ✓ |

**How the "5 failing e2e" were fixed.** They were never failing. They were 5 skips of `e2e/billing.spec.ts`, gated on `E2E_BILLING=1`
and a billing-mode server. Run that way they pass 5/5. `embedded.spec.ts`, `inbox-reading.spec.ts` and `journey.spec.ts`
(previously skipped when their env was missing) also ran and passed in this run: local `SHOPIFY_API_KEY`/`SECRET` test values
and the e2e database URL were given to the test process.
Repro: `docs/FINISH_LEDGER.md` §7 env + `npx playwright test`, then `E2E_BILLING=1` with the billing env in the header of
`e2e/billing.spec.ts`.

**Guardrail tests that caught the new code (fixed, not loosened):**
- privacy coverage: the phone tables are exported and erased by phone; the business line is exempt with its reason.
  `customers/redact` now also matches `customer.phone`.
- route sweep: the new routes are classified with their signature/rate-limit evidence.
- release sets: 065 is its own 2026-11-22 set, with its rollback.
- tenant isolation: E.164 sample values for the new tables.
- owner notify: the "named provider without a sender" case now uses `vonage`, and asserts that Twilio without an account holds.

PR: https://github.com/Jamesrevenueai/deploi-site/pull/21 (draft; not merged because of the gate).

Screenshot pairs (before = live production, after = this branch built locally with the flag on), 1440 and 390 wide:
- `proof/finish-2026-11-22/before/site-office-*.png` → `after/site-office-*.png`
- `proof/finish-2026-11-22/before/site-service-businesses-*.png` (404 today) → `after/site-service-businesses-*.png`
- `docs/listing-screenshots/listing-*.png`: 1600×900 embedded drafts (synthetic store, **not for submission**)
- App UI is unchanged with the flags off. Earlier app pairs: `proof/ship-2026-11-22/before` and `after-local` (commit 4f52669).
