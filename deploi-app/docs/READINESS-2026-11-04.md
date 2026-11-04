# Deploi readiness report — 2026-11-04

Branch `claude/deploi-full-implementation` (integration of eight workstreams). **Nothing on this branch is
merged or deployed.** Production (`deploi-app` on Vercel, Supabase `deploi-prod`) still runs `main` at
`e7d2b6c` with migrations through `20261030000035`.

Verification levels used below:

- **Live-tested**: exercised against the real third-party service.
- **Locally tested**: automated tests against local Postgres, synthetic providers and fake HTTP layers that
  check request shapes; plus browser tests against a production build.
- **Partial**: some of the requirement is built.
- **Blocked**: needs something outside the codebase (credentials, an account, a review, an approval).

No capability on this branch is live-tested. Every integration below is **locally tested** at most.

## 1. Test evidence

| Check | Result |
|---|---|
| Typecheck (`npx tsc --noEmit`) | clean |
| Lint (`npx eslint app components lib e2e tests scripts --quiet`) | clean |
| Unit + integration (`npx vitest run`, fresh database) | **FINAL_VITEST** (was 298/298 at session start) |
| Browser tests against `next build` (`npx playwright test`) | **FINAL_E2E** (3 skipped: embedded Shopify needs real Shopify credentials) |
| Production build (`npm run build`) | succeeds |
| Website (`npm test`, `npm run build` at repo root) | 47/47; build succeeds |
| Release migration rehearsal (`bash scripts/test-release-2026-11-04-migrations.sh`) | all checks pass: production host refused; dry run leaves nothing; apply keeps existing rows and backfills Commerce; 111 app tests pass on the migrated copy; rollback refuses while data exists and the refusal leaves all migrations in place; `--discard-data` rollback returns the schema to the original except the deliberately kept security hardening (8 lines); re-apply works |
| Forbidden-name scan (`scripts/forbidden-grep.sh`) | clean |

## 2. Capability status

| Capability | Status | Evidence / what is missing |
|---|---|---|
| Shopify install, OAuth, embedded session tokens | Locally tested | `tests/shopify/*`. Expiring offline tokens with refresh and rotation; refusal → connection `needs_reauth`. |
| Shopify mandatory privacy webhooks | Locally tested | `lib/connectors/shopify/compliance.ts`; `shop/redact` skips a reinstalled shop. |
| Shopify inventory monitoring (webhook + hourly) | Locally tested | Debounced targeted rescans (`rescans.ts`); throttle-aware client. |
| Shopify corrections (oversell, publication, price, SKU) with verification | Locally tested | Unpublish verification tolerates a channel missing from `resourcePublicationsV2`. Live behaviours still to confirm: `docs/SHOPIFY-SETUP.md` §2. |
| Supplier workflow (Supplier Chaser) | Locally tested | Per-SKU supplier mapping, one request per supplier per day, reply + ETA recorded as data, follow-up withdrawn on reply. |
| WooCommerce connection (wc-auth flow + pasted keys) | Locally tested | One-time signed state; keys encrypted; SSRF-safe client (public addresses only, no redirects). |
| WooCommerce corrections (backorders, price, SKU, publish/draft) + verification | Locally tested | `tests/woocommerce/*` incl. review and authorized modes, stale preconditions, unknown outcomes never re-sent. |
| WooCommerce webhooks | Locally tested | HMAC-SHA256 verified, de-duplicated, targeted rescans. |
| Shared engine: durable job queue | Locally tested | `lib/jobs`: leases, backoff, dead-letter, per-org idempotency and concurrency. |
| One authorization check for every agent action | Locally tested | `lib/engine/authorize.ts` on store writes (Shopify and WooCommerce), email sends, job runs. Office actions run their own equivalent claim check plus the org stop. |
| Organization "stop all agents" | Locally tested (UI + API + e2e) | Pauses store and Office agents, cancels queued work, holds sends, refuses grant/resume; owner turns it off from the Control Room. |
| Unified approvals | Locally tested | Sources: store changes, emails, library actions, Office actions. Decisions bound to the content hash shown. |
| Audit log (tamper-evident) | Locally tested | Per-org hash chain on `engine_audit`; verify function; CSV export. |
| Agent email: send | Locally tested; **Blocked** live | Resend adapter; `EMAIL_LIVE_SENDS=off` by default. Needs verified domain + key. |
| Agent email: receive, threading, customer inbox, human replies | Locally tested; **Blocked** live | svix-verified inbound; suppression on bounce/complaint/unsubscribe; per-org daily cap; loop protection. |
| Deploi Office: HubSpot | Locally tested; **Blocked** live | OAuth, refresh, contacts/deals/notes/tasks against a fake HTTP layer + synthetic provider. Needs a HubSpot public app. |
| Deploi Office: Google Calendar | Locally tested; **Blocked** live | OAuth + PKCE, freeBusy, idempotent event insert/patch/delete. Needs a Google OAuth client; production needs Google app verification (sensitive scopes). |
| Lead follow-up, meeting scheduling, CRM updates, customer replies | Locally tested | Drafts-only default; all three tiers tested end to end with synthetic providers; booking idempotency. |
| Onboarding + automatic agent setup | Locally tested (UI + e2e) | Agents created at drafts only, each granted by the owner; resumable; never duplicates. |
| Control Room, integrations, agent configuration UI | Locally tested (e2e + screenshots in `proof/cx-*`) | Integrations show honest status; nothing reads "connected" without a connection row. |
| Website | Locally tested | Commerce (Shopify/WooCommerce) + Office positioning; pilot CTA; legal links labelled DRAFT. Not deployed. |
| Legal drafts | **Drafts only** | `docs/legal/*` (9 documents + review checklist), every one headed DRAFT. Not reviewed by counsel; nothing marks them published. |
| Agreement acceptance tracking + gate | Locally tested | Append-only acceptances (who, when, IP, UA, document hash). Gate on store/Office connect, agent create/grant, billing. `LEGAL_GATE=off` by default. |
| Billing: Stripe subscriptions | Locally tested; **Blocked** live | Checkout, portal, signature-verified webhook. `BILLING_MODE=off` by default; live mode refuses without explicit live config. Needs Stripe account + prices. |
| Billing: Shopify App Store merchants | Partial | Status read + webhook-triggered refresh; no `appSubscriptionCreate` (App Pricing is set in the Partner Dashboard). `BILLING_REQUIRED` off. |
| Plan enforcement | PLAN_STATUS | Agents, competitor stores, monthly emails, Office limits; ALLOWANCE_STATUS |
| Tenant isolation | Locally tested | Catalog-driven tests: every table has RLS + a scoped policy or a documented deny-all; org A reads 0 rows of org B in every org-scoped table; credential tables unreadable by user roles. |
| Abuse protection / CSP | RATE_STATUS | |

## 3. Security findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-02 | **Critical** | Sign-up trusts user-supplied metadata for role/organization: anyone can sign up as staff | **Fixed on the branch; LIVE IN PRODUCTION NOW** — verified read-only on 2026-11-04: production's `handle_new_user` reads `raw_user_meta_data`, email sign-up is enabled. Fix ships with migration 042. **Founder action 1.** |
| F-01 | **Critical** | `leads` view readable by every signed-in user | Fixed on the branch (042); live in production until deployed |
| F-03 | High | Staff decided by substring match | Fixed on the branch (042); live in production (verified) |
| F-04 | High | TRUNCATE granted to user roles | Fixed on the branch (042) |
| I-01 | High | Migrations 039 and 040 each redefined `email_messages.task_key`; 040 dropped `human_reply`, so customer-inbox replies would fail to save | Fixed by migration 043 (found at integration) |
| I-02 | Medium | Server-only tables (WooCommerce key and webhook-secret ciphertext, Office tokens/OAuth states) carried default user-role grants | Fixed by migration 043 |
| I-03 | Medium | After "Stop all agents" the UI had no way to turn the stop off | Fixed (Control Room banner + clear) |
| V-01 | Medium | A preview environment variable whose *name* is a 32-hex string (`ec6e664e…`) — a secret pasted into the name field | Open: **founder action** |
| V-02 | Medium | Shopify dev client secret marked "shared in chat; rotate after testing" | Open: **founder action** |
| F-07 | Medium | Shopify customer privacy webhooks answer "no customer data held"; untrue once order/customer agents or agent email hold shopper data | Open: change before such agents ship |
| F-08 | Medium | Any member of an organization can grant agent authorizations (no owner-only role) | Open |
| F-13 | Info | Dev sign-in on production per `PRODUCTION-SAFETY.md` §2 | Open: verify Production env has no `AUTH_MODE=dev` / `ALLOW_DEV_LOGIN` (Vercel listing on 2026-11-04 shows both set for **Preview only**) |
| Others | | `docs/SECURITY-REVIEW-2026-11-04.md` | |

## 4. Blockers and the exact founder actions

1. **Today, independent of this branch — close F-02 in production.** Supabase → deploi-prod → Authentication →
   Sign In / Providers → Email → turn off "Allow new users to sign up" (invites keep working). Then check
   `select email, role, created_at from profiles where role = 'staff'` and remove any staff profile that is
   not yours. Production has 3 staff profiles; `STAFF_EMAILS` lists 2 addresses.
2. **Grant this session (or a future one) push access to `deploi-site`** so the branch can be pushed and a
   draft PR opened. The request was refused in this session.
3. **Apply migrations 036–043 (044 if merged) to production**, after review, with
   `npx tsx scripts/launch-migrations.ts dry-run --set=2026-11-04 --http=makqaqzlylhckijdbjzi --confirm-production=makqaqzlylhckijdbjzi`,
   then `apply`. Do preview (`bhddgjcefwasdyrrfptc`) first. This session was not permitted to run even a
   rolled-back dry run on preview.
4. **Vercel hygiene**: delete the preview env var named `ec6e664e…` and rotate whatever value it held; rotate
   the Shopify dev client secret; set `CREDENTIALS_ENCRYPTION_KEY` / `CREDENTIALS_KEY_ID` on Production.
5. **Shopify**: dev store + "Deploi (dev)" app, env vars, install, run `scripts/shopify-devstore-check.ts`
   (`docs/SHOPIFY-SETUP.md` §2, steps 1–11). App Store listing items: `docs/APP-STORE-OPEN-ITEMS.md`.
6. **WooCommerce**: an HTTPS store you own (WC ≥ 3.5, pretty permalinks); `docs/WOOCOMMERCE-SETUP.md`.
7. **Email**: verify `AGENT_MAIL_DOMAIN` in Resend; webhook to `/api/webhooks/agent-mail` for received,
   bounced, complained, delivered; `RESEND_API_KEY`, `AGENT_MAIL_WEBHOOK_SECRET`, `EMAIL_LIVE_SENDS=allowlist`,
   `EMAIL_TEST_RECIPIENTS=<you>` (`docs/EMAIL-SETUP.md`).
8. **Office**: HubSpot public app + test portal; Google Cloud OAuth client with the Calendar API; Google app
   verification before public use (`docs/OFFICE-SETUP.md`).
9. **Stripe**: three monthly prices (`STRIPE_PRICE_{STARTER,GROWTH,PRO}_MONTHLY`), webhook to
   `/api/billing/stripe/webhook`, Customer Portal on; `BILLING_MODE=test` on preview only.
10. **Counsel**: `docs/legal/REVIEW-CHECKLIST.md`; publish the reviewed versions (SQL in the checklist), then
    `LEGAL_GATE=enforce` and `VITE_LEGAL_REVIEWED=true` on the site.

## 5. Are we ready for paying pilot customers?

**Not yet.** The code for every brief objective exists and passes local and browser tests, but:

- the critical sign-up hole (F-02) is live in production today;
- nothing on this branch is deployed, and its migrations are not applied anywhere real;
- no integration has run against a real Shopify store, WooCommerce store, mailbox, HubSpot portal, Google
  calendar or Stripe account;
- the legal documents are unreviewed drafts, and billing is off.

The shortest path to a first paid pilot: founder actions 1–4, then one live run each of Shopify (or
WooCommerce) + agent email on your own accounts, counsel sign-off on the Terms, Privacy Policy, DPA, AI Agent
Authorization Terms and Pilot Agreement, and a pilot invoiced directly (Stripe can follow).
