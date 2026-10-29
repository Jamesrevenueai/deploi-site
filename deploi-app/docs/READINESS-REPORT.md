# Readiness report: Deploi agents, the four Shopify corrections, the email connector and App Store readiness

Date: 2026-10-29. Branch `subscription-product`, draft PR #1 (not merged). Controlling brief: `docs/PRODUCT-BRIEF.md`.

## Verdict

**The requested launch is not complete.** All four correction types and the authorized autonomous agent
experience are built and meet their acceptance criteria **against a synthetic Shopify store**. The email
connector (Gmail and Microsoft 365 adapters, per-agent email permissions, review and sending) is built and
meets its acceptance criteria **against a synthetic mailbox**. None of it has run against a real Shopify store
or a real mailbox yet, and no real email has been sent. The public-app work for the Shopify App Store
(installation, tokens, App Bridge, webhooks, store access replacing the development-only allowlist, Shopify App
Pricing) is implemented and tested locally. **The app has not been submitted to Shopify, and Shopify has not
reviewed or approved it.** The submission package and every remaining blocker are in
`docs/APP-STORE-SUBMISSION.md`. The brief says not to call the launch complete until the acceptance
criteria are met, and live verification is part of that, so this report does not call it complete. What
remains, and how to close it, is below.

## 1. Verified locally (synthetic store, local Postgres)

| Check | Result |
|---|---|
| Typecheck (`npx tsc --noEmit`) | clean |
| Lint (`npx eslint app components lib e2e tests --quiet`) | clean |
| App unit and integration tests (`npx vitest run`) | **69 files, 415 tests passed** |
| Production build (`npm run build`) | succeeded |
| Browser tests against the production build (`store`, `agents`, `email`, `embedded` specs) | **19/19 passed** |
| Website tests (`npm test` in the site root) / build | 37/37 passed; build succeeded |
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
1. Create a development store and the app, and set the environment variables. Development stores are enabled for changes automatically (`STORE_ACCESS_MODE=beta`).
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
- **Production database**: migrations `20261028000028` to `20261029000032` are not applied. Apply them before merging PR #1.
- **Shopify App Store**: Partner account and app, a real development-store run, pricing decision, icon,
  screenshots, screencast, emergency contact, legal review, then Shopify's review. Full list:
  `docs/APP-STORE-SUBMISSION.md` §5.
- **WooCommerce and Amazon**: planned. Detection logic is written and tested, but the connectors refuse every
  call by design.

## 5. Production incident and what to do about it

- **What happened.** Earlier in this work, pushes to `main` deployed both Vercel projects to production. My
  attempt to roll back was blocked by the session's permission rules, so production was **not** restored. Since
  then, all work is on `subscription-product`, which creates preview deployments only.
- **Current production app:** deployment `dpl_2EERM2Hxr5Mro1QkiZ4t1XtqJtkv` (commit `b8aad24`). Sign-in there is
  likely broken because the production database lacks the newer columns (`agencies.org_type`).
- **Previous good deployments:** app `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X`, site `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY`.
- **To fix:**
  - **Fastest:** Vercel dashboard → each project → Deployments → the previous good deployment → *Instant
    Rollback* (or *Promote to Production*).
  - **Otherwise:** apply migrations 0028–0032 to production and then merge PR #1 after review.
- **Also on production:** `AUTH_MODE=dev` is still set on the production app. Change it before any real merchant
  signs in.
- **Domain:** `getdeploi.com` DNS still points to the previous host. The new site is live only at its Vercel URL.

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
