# Readiness report: Deploi agent platform

Updated 2026-10-28. Branches:
- `subscription-product`: draft PR #1, the merchant engine, agents and the email connector;
- `claude/agents-platform`: draft PR #3, base PR #1, the agent platform below;
- `claude/prod-auth-guard`: draft PR #2, base `main`, the production auth guard only.

**Nothing is merged and nothing is deployed.** Controlling briefs: `docs/PRODUCT-BRIEF.md` and the 2026-10-28 agent-platform brief.

## Verdict

**The launch is not complete.** Everything below is built and passes against a synthetic Shopify store, a fake Resend API and local Postgres. None of it has run against a real Shopify development store or a real mailbox, and no real email has been sent.

Production right now is on the rolled-back deployments (verified). It **still allows password-free dev sign-in**: you chose to fix that later, and the steps are in `docs/PRODUCTION-SAFETY.md` §2.

## 0. Agent platform (PR #3): what was added and how it is proven

| Requirement | Built in | Proof |
|---|---|---|
| Three tiers per tool (drafts only / after approval / without asking within scope, at most one year); new agents and email default to drafts only | `lib/agents/policy.ts` (`APPROVAL_MODES`, `TIERS`, `validUntil`), `lib/agents/plan.ts#qualifies`, `lib/engine/approve.ts` | `tests/merchant/platform.test.ts` (drafts write nothing and cannot be approved; an ended authorization fails closed); `e2e/platform.spec.ts` |
| Widening any permission needs a new grant (tier up, later end date, new checks, recipients…) | `expansionReasons` | platform test "widening drafts -> review"; screenshot `proof/platform-widen-needs-grant-*` |
| Job description to visible rules approved before running | existing parse + summary, plus the tier wording | `proof/platform-template-authorize-*` |
| Pause / revoke / delete instantly (now also cancels queued tasks and closes the agent's mailbox) | `lib/agents/lifecycle.ts` | agents tests; platform test "paused agent… deleting cancels" |
| Templates: Inventory Watcher, Supplier Chaser, Store Health Checker, pre-filled at drafts only | `lib/agents/templates.ts`, `app/api/store/agents` | platform tests; `proof/platform-agents-*` |
| Plain-language tasks; honest statuses; "done" only with a finished run as proof | `lib/agents/tasks.ts` | platform tests; e2e (Waiting on you / Needs your approval / Refused) |
| Work log: what, when, why, which permission | `lib/agents/worklog.ts` | platform test; `proof/platform-agent-detail-*` |
| Weekly summary (per agent, attention, time saved labelled **Estimate** with its formula), once a week, never "sent" unless the provider accepted it | `lib/agents/weekly.ts`, `/api/cron/weekly-summary` (Mondays 13:13 UTC) | platform tests (prepared when sends are off; sent once with an idempotency key) |
| Agent mailboxes on our domain; no Gmail restricted scopes; inbound, threading, recipient allowlist, no duplicate sends, full audit | `lib/email/adapters/deploi.ts`, `lib/email/mailbox.ts`, `lib/email/inbound.ts`, `app/api/webhooks/agent-mail` | 7 platform tests + webhook-guard test. **Not live-verified.** |
| Gmail / Microsoft kept, off by default, labelled not live-verified | `providerStatus` (`EMAIL_OAUTH_PROVIDERS=on` to show) | existing email tests |
| Pluggable connectors; agents have no tool access by default | `lib/engine/capabilities.ts` | `tests/merchant/connector-plugin.test.ts`: an in-memory WooCommerce connector runs an agent end to end with no agent, permission or audit code naming it |
| Cross-organization isolation of the new data | RLS in migration 032 | platform test "organization isolation" |
| Production AUTH_MODE guard | `lib/auth-guard.ts` | `tests/security/production-auth.test.ts`; a real `next build` exits 1 |
| Sandboxed computer | design only | `docs/SANDBOX-DESIGN.md` |
| Migrations 28–32: script and rollback, tested on a copy, not on production | `scripts/launch-migrations.ts`, `supabase/rollback/` | `scripts/test-launch-migrations.sh`: all checks pass (§1) |

## 1. Verified locally (synthetic store, local Postgres)

| Check | Result |
|---|---|
| Typecheck (`npx tsc --noEmit`) | clean |
| Lint (`npx eslint app components lib e2e tests --quiet`) | clean |
| App unit and integration tests (`npx vitest run`) | **71 files, 436 tests passed** (was 398 before this work) |
| Production build (`npm run build`) | succeeded |
| Browser tests against the production build (all of `e2e/`: store, agents, email, platform, flow, security) | **31/31 passed** |
| Website tests (`npm test` in the site root) / build | 34/34 passed; build succeeded |
| Launch migrations on a copy (`bash scripts/test-launch-migrations.sh`) | all checks passed: the production host is refused; a dry run changes nothing; apply keeps existing rows; 42 merchant and platform tests pass on the migrated copy; a refused rollback leaves all 5 migrations in place; rollback with `--discard-data` leaves the schema byte-identical to the original and the original rows intact; re-apply works |
| Forbidden-name scan (`scripts/forbidden-grep.sh`) | passes |
| `.env.local` | still gitignored; no env file is tracked |

### Acceptance criteria, as tested

| Brief requirement | Where it is tested | Status |
|---|---|---|
| Overselling settings against an explicit rule, keeping pre-order and backorder exceptions | `tests/merchant/agents.test.ts` (Stock Guardian), `tests/shopify/detection.test.ts`, `tests/merchant/workflow.test.ts` | Synthetic-verified |
| Publication: authorized channel only; drafts, archived and scheduled products not treated as errors; no status change; unpublish only if allowed | `tests/shopify/listing-checks.test.ts`, agents test "publication workflow" | Synthetic-verified |
| Price: price list or rule, store currency only, limits, sale prices and fixed Markets prices protected, nothing invented | listing-checks "price workflow", agents test "price workflow" | Synthetic-verified |
| SKU: unambiguous mappings only; ambiguous matches blocked; no generated identifiers or duplicates | listing-checks "SKU workflow", agents test "SKU workflow" | Synthetic-verified |
| Named agents created from plain English; "fix my store" grants nothing | agents test "plain English", `e2e/agents.spec.ts` wizard | Verified (UI and API) |
| Readable authorization summary; grant bound to the exact version reviewed | agents test "grant is bound", wizard e2e | Verified |
| Review mode vs authorized autonomous mode; each execution bound to the authorization version and recording why it qualified | agents tests "autonomous", "review mode" | Synthetic-verified |
| Permission expansion needs re-approval; narrowing applies at once | agents test "authorization changes" | Verified |
| Pause and revoke stop all writes, including queued ones | agents test "pause and revoke" | Verified |
| Recheck before writing, stale proposals invalidated, changed reference data makes approvals stale | agents test "changed reference data", workflow test "stale data" | Synthetic-verified |
| Verification by fresh read; truthful statuses (awaiting approval, queued, running, blocked, failed, verified) | agents test "outcome verification", `tests/merchant/agent-status.test.ts` | Synthetic-verified |
| No duplicates, conflicts or loops; bounded retries | workflow tests (duplicates, loop guard, retries), agents test "conflicting agents" | Verified |
| Organization isolation; staff cannot act; connector enforces writable fields | agents test "grant is bound…", `tests/merchant/isolation.test.ts`, agents test "connector refuses" | Verified |
| Files and store content are data, not instructions | agents test "files are data" | Verified |
| Recurring runs; paused agents do not run | agents test "recurring execution" | Verified (scheduler function; the hosted cron itself is not exercised) |

## 2. Email connector

Full setup, permissions and provider approval steps: `docs/EMAIL-SETUP.md`. Research with sources:
`docs/platform-research/email.md`.

### Provider status

| Provider | Implemented | Locally tested | Live verified | Externally blocked |
|---|---|---|---|---|
| Synthetic mailbox (test only) | yes | yes: every engine path, fault injection, browser tests | n/a: it never emails anyone | no |
| Gmail / Google Workspace | yes: OAuth with PKCE, identity, send, revoke; reply tracking only with read access | request shapes and outcome mapping against a fake HTTP layer | **no** | **yes**: needs an OAuth client and test users. Public use needs Google brand and sensitive-scope (`gmail.send`) verification. Reading replies (`gmail.readonly`) also needs restricted-scope verification and an annual security assessment. |
| Microsoft 365 / Outlook | yes: OAuth with PKCE, identity, send | request shapes and outcome mapping against a fake HTTP layer | **no** | **yes**: needs an app registration. A public multi-tenant app needs publisher verification. Reading (`Mail.ReadBasic`) needs admin consent in most organizations. Reply tracking and Sent-folder lookup are off until checked on a test tenant. |

In the app, Gmail and Microsoft show **Not available yet (needs setup)** with a disabled Connect button until their
credentials are set. Real sends are also refused unless `EMAIL_LIVE_SENDS` allows them (`off` by default;
`allowlist` limits them to `EMAIL_TEST_RECIPIENTS`).

### Email acceptance criteria, as tested

| Brief requirement | Where it is tested | Status |
|---|---|---|
| OAuth only, never a password; one-time state bound to the organization and user; a refused or narrowed consent connects nothing that can send | `tests/merchant/email.test.ts` "connecting uses one-time state…", `e2e/email.spec.ts` "connect a synthetic mailbox" | Synthetic-verified |
| Connections shows sender, health, granted permissions, check, reconnect, add read access, disconnect | `e2e/email.spec.ts`, `tests/merchant/email-status.test.ts` | Verified (UI) |
| Connecting authorizes no agent; email permission is per agent (drafts / send approved / send within limits) | email test "connecting an account authorizes no agent", "draft-only permission…" | Verified |
| Before granting: sender, recipient rules, purpose, limits and end date shown; sending without asking needs an end date within a year | email test "readable summary…", `tests/merchant/agent-form-email.test.ts`, wizard in `e2e/email.spec.ts` | Verified |
| Messages outside the rules wait for approval; widening email access needs a new grant | email tests "qualification blocks…", "expired authorization…", "readable summary…" | Verified |
| Reading mail is a separate permission, only for supplier restock tasks | email test "the policy refuses… reading without a task", agent form tests | Verified |
| Review shows the exact sender, recipients, subject, body and attachments; an edit invalidates the approval; only approved content is sent | email test "review mode…", `e2e/email.spec.ts` "review the exact message, edit it, approve it" | Synthetic-verified |
| Autonomous mode checks the policy in code before every send and records the authorization version | email test "autonomous mode…" | Synthetic-verified |
| Incoming email and attachments cannot widen permissions; store data cannot inject headers or recipients | email tests "incoming email can only be counted as a reply", "store data can never inject headers or recipients" | Verified |
| Pause, revoke and disconnect stop queued sends | email test "pause, revoke and disconnect…", `e2e/email.spec.ts` "disconnecting the account cancels…" | Verified |
| No duplicates; an uncertain outcome is reconciled before any retry and never sent twice | email tests "duplicate prevention…", "uncertain responses…", "without read access…" | Synthetic-verified |
| Statuses Draft, Awaiting approval, Queued, Sending, Accepted by provider, Failed, Delivery unknown; delivery never claimed | `tests/merchant/email-status.test.ts`, Gmail and Microsoft adapter tests | Verified |
| Tokens and message content encrypted; content hidden from user sessions and staff; organizations isolated | email test "organization isolation and staff…", `e2e/email.spec.ts` "another organization cannot see…", migration `20261028000031` column grants | Verified |
| No real email from development | email test "real providers never send from development…" | Verified |

**Not covered by the browser tests:** the embedded `/shopify/connections` popup connection flow (it uses the same
API as the standalone page, which is covered).

**Light-theme redesign:** this repository has no light theme on any branch. The app and website are dark. I
did not change any styling, so there was nothing to preserve or break.

## 3. Not yet verified live (needs a Shopify development store)

None of this has run against Shopify itself. The calls follow the official Admin GraphQL 2026-10 documentation
(`docs/platform-research/shopify-workflows.md`), but these behaviours are unconfirmed:

1. `productVariantsBulkUpdate` setting `inventoryItem.sku` with `write_products` only (it may need `write_inventory`).
2. `publishablePublish` / `publishableUnpublish` results showing on the next read, and how they behave on draft,
   archived and unlisted products. The engine verifies unpublish by reading the channel back as unpublished. If
   Shopify drops the channel from `resourcePublicationsV2` instead of returning `isPublished: false`, an unpublish
   would show as **Failed (verification)** rather than **Verified**. That would be a false alarm, not a false success.
3. Whether the `publications` query lists the merchant's channels for this app, and channel titles in other languages.
4. The `priceLists … originType: FIXED` lookup that blocks variants with fixed Markets or B2B prices (needs
   `read_products` plus the catalog staff permission).
5. Price precision beyond the currency's minor unit; whether SKU search is exact.
6. Query cost of the variant read with publications, barcodes and prices; throttling under real page sizes.
7. Expiring offline tokens and refresh, App Bridge session tokens, and the embedded `/shopify/agents` pages.
   The browser tests cover only the standalone `/store` pages.
8. The hourly `/api/cron/agents` schedule on Vercel (needs `CRON_SECRET`).

**How to verify:** follow `docs/SHOPIFY-SETUP.md` §2. In short:
1. Create a development store and the app, set the environment variables, and set `LIVE_WRITE_STORES` to only that store.
2. Install the app.
3. Upload the three demo CSVs, adapted to the store's real products.
4. Create one agent per correction type, run each in review mode and then authorized mode, and confirm every
   change shows **Verified** in Deploi and in the Shopify admin.
5. Record the answers to items 1–8 in `docs/platform-research/shopify-workflows.md`.

## 4. External blockers (need you or a third party)

- **Shopify Partner account and development store**: needed for everything in §2.
- **App Store submission**:
  - Billing plans and prices; Shopify App Pricing is set in the Partner Dashboard and none are decided.
  - Partner API credentials to read subscription status.
  - App name, listing copy and a 1200×1200 icon.
  - A legally reviewed privacy policy (the draft on the website is pending legal review).
  - An emergency contact, a demo screencast and reviewer test credentials.
  - Then Shopify's review itself.
- **Gmail and Microsoft accounts**: OAuth clients, test users and a test tenant for live email verification
  (`docs/EMAIL-SETUP.md`, "Live verification"). Public launch then needs Google verification and Microsoft
  publisher verification.
- **Production database**: migrations `20261028000028` to `…032` are not applied. Use `scripts/launch-migrations.ts` (tested on a copy) with your approval, before merging PR #1.
- **Agent mail live test**: needs `AGENT_MAIL_DOMAIN` DNS and Resend domain verification (`docs/LAUNCH-DNS.md` §B), and **your dedicated test address**.
- **Production dev sign-in**: remove `AUTH_MODE` and `ALLOW_DEV_LOGIN` from Production (`docs/PRODUCTION-SAFETY.md` §2).
- **WooCommerce and Amazon**: planned. Detection logic is written and tested, but the connectors refuse every
  call by design.

## 5. Production (verified 2026-10-28; full detail in `docs/PRODUCTION-SAFETY.md`)

- **Rollback is in effect.**
  - `app.getdeploi.com` → `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` (`fd0e89e`).
  - `getdeploi.com` (Vercel side) → `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY` (`fd0e89e`).
  - The `b8aad24` builds have no production domain.
- **Open:** production has `AUTH_MODE=dev` and `ALLOW_DEV_LOGIN=true`, so `/login` lists staff users with no password. The exact fix steps are in `PRODUCTION-SAFETY.md` §2. PR #2 makes a production build fail while those variables exist.
- **Cause of the bad deploy:** direct pushes to `main` deploy both projects. The repository and root-directory links are correct. Fixes: per-project ignore steps (PR #2), and branch protection on `main` (needs you).
- **Production database:** migrations 28–32 are not applied. Use `scripts/launch-migrations.ts apply --db <url> --confirm-production=<ref>`, only with your approval.
- **Domain:** `getdeploi.com` DNS is still Squarespace. Records to change: `docs/LAUNCH-DNS.md` §A.
- **Crons:** `vercel.json` adds the hourly agent cron and a weekly summary cron. Hourly crons already exist on `main` (`0 * * * *`) and those production builds succeeded, so the plan allows them.

## 6. Demo

`docs/SHOPIFY-SETUP.md` §1. Seeded Northwind agents:

| Agent | Mode | What a run shows |
|---|---|---|
| Stock Guardian | autonomous | verified corrections |
| Price Keeper | review | waiting changes plus items for a person |
| Channel Keeper | review | publication |
| SKU Filler | autonomous | fills only unambiguous SKUs |

Their authorizations are marked as granted by the seeded demo owner. Running the test suite resets them, so run
`npm run seed` before a demo or the browser tests.

For email: Connections → *Synthetic mailbox (test only)* → Connect, then create an agent with email tasks. The
synthetic mailbox never emails anyone.
