# Shopify App Store submission package

Date: 2026-10-29. **Status: not submitted.** Shopify has not reviewed or approved Deploi. Nothing in this
document is an acceptance or approval by Shopify. Requirements are from
`docs/platform-research/shopify-app-store.md` (shopify.dev, read 2026-10-29); anything marked UNVERIFIED there is
still unverified.

## 1. What the code now does (implemented and tested locally; not yet run on a real store)

| Requirement | Implementation | Local evidence |
|---|---|---|
| Install from Shopify surfaces only, authenticate immediately, land in the app UI, also after reinstall (2.3.1–2.3.4) | Shopify managed installation (scopes in TOML, `use_legacy_install_flow` omitted) + token exchange on first load (`/api/shopify/session`). No screen asks for a shop domain. | `tests/merchant/shopify-routes.test.ts`, `e2e/embedded.spec.ts` |
| Expiring offline tokens only (3.1.2) | `expiring=1` on token exchange **and** on the code-grant fallback; refresh under a row lock; a refused refresh deletes the credential so the next app open re-exchanges | `tests/merchant/app-store.test.ts` |
| ID tokens, no third-party cookies or local storage for auth (1.1.1) | HS256 with the client secret; `aud`, `exp`/`nbf`, `iss`/`dest` checked; 401 with `X-Shopify-Retry-Invalid-Session-Request: 1` on failure | unit tests, `e2e/embedded.spec.ts` |
| Latest App Bridge before any other script (2.2.3) | Root layout renders the meta + CDN script; middleware moves them to the top of `<head>` on embedded page loads (Next.js emits its own scripts first otherwise) | `e2e/embedded.spec.ts` checks the first `<script>` of the served HTML |
| Framing | `frame-ancestors https://<shop> https://admin.shopify.com` on `/shopify/*`; `'none'` elsewhere | unit + e2e |
| GraphQL Admin API only (2.2.4), version `2026-10` | no REST calls | code |
| Mandatory compliance webhooks; 401 on a bad HMAC | one endpoint for all topics; HMAC over the raw body; dedup by `X-Shopify-Webhook-Id`; `shop/redact` erases the shop (and its access record); `customers/*` acknowledged (no customer data held) | `tests/merchant/shopify-routes.test.ts`, `tests/merchant/access.test.ts` |
| Uninstall handling | `app/uninstalled`: connection inactive, token deleted, pending changes blocked; agents and email stop because the store is no longer active | tests |
| Minimal scopes, no protected customer data | `read_products, write_products, read_inventory, read_locations, read_publications, write_publications`; no customer/order scopes | TOML example test |
| Billing through Shopify (1.2.x) | Shopify App Pricing: Partner API `activeSubscription`, plan page opened at `_top`, no `appSubscriptionCreate`; gated by `BILLING_REQUIRED` (off: no plans yet) | `tests/merchant/app-store.test.ts` |
| Off-platform features inside the admin (2.2.2) | Connections (mailboxes), agents, approvals, email review and work logs all exist under `/shopify/*` | e2e (standalone and embedded) |
| Tenant isolation | the verified ID token's shop maps to exactly one organization; every store API resolves the organization from it; Postgres RLS on every merchant table | `isolation`, `access`, `email` tests |

### Development-only restrictions removed

`LIVE_WRITE_STORES` (an environment allowlist) is gone. Store access is now a database record per shop
(`lib/engine/access.ts`, migration `20261029000032`), decided in code before every write and every real email:

1. a staff **denial** blocks everything; a staff **approval** enables the store (`/staff/store-access`, audited);
2. a redeemed **beta invite** enables it (codes `DPL-XXXXX-XXXXX-XXXXX`, stored only as SHA-256 hashes, single
   use by default, optionally bound to one shop, expiring, revocable; 10 failed codes per store per hour);
3. a **development store** (Shopify's `shop.plan.partnerDevelopment`, read with the store's own token, re-checked
   daily) is enabled automatically;
4. `STORE_ACCESS_MODE=open` enables every installed store.

A store without access is still installed, scanned and fully reviewable (issues, evidence, proposed changes,
agents, email drafts); it cannot be written to and cannot send real email, and it sees a card to enter an invite
code or request access. `LIVE_WRITES=off` pauses writes to every real store.

**Reviewer access.** Shopify does not say which store type reviewers use (UNVERIFIED), and reviewers must get full
feature access. So **submit with `STORE_ACCESS_MODE=open`**. Keep the beta audience small with a
**limited-visibility** listing (installable only from its listing URL, not indexed) and, once pricing exists,
private plans. The invite flow covers beta merchants before then, and is a fallback for reviewers (an invite
code goes in the testing instructions).

## 2. Configuration to enter in the Dev Dashboard / Partner Dashboard

1. `shopify app config link` against the production app, merge `shopify.app.toml.example`, fill `client_id` and
   `handle`, then `shopify app deploy`.
2. App URL `https://app.getdeploi.com/shopify` (no "shopify" or "example" in the host).
3. Compliance webhooks: all three topics → `https://app.getdeploi.com/api/shopify/webhooks` (declared in TOML).
4. App icon 1200 × 1200 PNG/JPEG: no text, screenshots or Shopify marks. **Draft:** `docs/app-store/icon-1200.jpg`
   (source `docs/app-store/icon.svg`): the glass agent cube from the website illustrations. Needs your sign-off.
5. API contact email without "Shopify"; emergency developer contact (email **and phone**) (**you**).
6. Protected customer data: **not requested** (the app reads no customer or order data).
7. Distribution: **public**. It cannot be changed after it is chosen. If a live pilot store must run before
   approval, that needs a separate custom-distribution app.

## 3. Listing draft (English only; no statistics, superlatives, testimonials or prices in text or images)

- **App name:** Deploi AI. It must match the TOML `name`. A web search on 2026-10-29 found no App Store app named
  "Deploi" or "Deploi AI". The nearest is "Deployify" (a theme-deploy tool), which is similar in spelling but
  different. This is not a trademark search.
- **Subtitle / tagline:** Named agents that fix store data you authorize
- **Introduction:** Deploi finds overselling settings, prices, SKUs and channel listings that don't match your
  rules, and changes them only within the authority you grant.
- **Details:**
  Create a named agent in plain English, for example "keep out-of-stock products from selling, except
  pre-orders". Deploi turns that into a readable authorization: which products, which single field, which
  limits and schedule. Nothing runs until you grant it. Each agent either asks before every change or acts
  within your limits. Every change is checked against a fresh read just before it is made and confirmed
  afterwards. Every run, change, failure and approval is kept in a work log. Optionally connect a Gmail or
  Microsoft 365 mailbox so an agent can draft supplier restock requests, which you review before they are sent.
- **Feature bullets:**
  - Agents you name, with authorizations you read and grant
  - Fixes overselling settings while respecting pre-order and backorder tags
  - Applies prices, compare-at prices and SKUs from your own files
  - Publishes or unpublishes products on the one channel you choose
  - Review each change, or let an agent act within limits
  - A work log of every change, with before and after values
  - Optional supplier restock emails from your own mailbox
- **Pricing details:** Free during early access. **This is a decision you must make.** Pricing goes only in the
  pricing section and must match Shopify App Pricing plans.
- **Categories / tags:** Store management → Operations / Inventory management (to be confirmed in the form).
- **Requires Online Store channel:** No. **Languages:** English. **Integrations:** Gmail, Microsoft Outlook.
- **URLs:**
  - Privacy policy: `https://getdeploi.com/privacy`
  - Support: `https://getdeploi.com/support`
  - Terms: `https://getdeploi.com/terms`
  - All three are live only once getdeploi.com points at the new website.
  - The privacy policy and terms are drafts pending legal review.
- **Support email:** `hello@getdeploi.com`. Confirm it is monitored.

### Screenshots (3–6, 1600 × 900, real UI, no browser frame, alt text)

Drafts from the synthetic store are produced by `E2E_SCREENS_DIR=… npx playwright test e2e/embedded.spec.ts`
(overview, agents, issues, connections). **Final screenshots must come from a development store in the real
admin**, without "synthetic" labels:

1. Agent authorization summary before granting. Alt text: "Readable authorization for a new agent before it is granted"
2. Agents list. Alt text: "Named agents with their mode and schedule"
3. A proposed change with evidence. Alt text: "Proposed price change with the price-list row as evidence"
4. Work log. Alt text: "Work log of verified changes with before and after values"
5. Email review. Alt text: "Supplier restock email shown in full for approval"
6. Connections. Alt text: "Store and mailbox connections with permissions"

### Demo screencast (English, step by step, about 3 minutes)

1. Install from the listing on a development store. The permission screen shows the scopes, then the app opens
   in the admin.
2. Overview: the first scan's issues, each with evidence.
3. Create an agent: "Every 6 hours stop out-of-stock products from selling, except pre-order". Show the
   structured review, the readable authorization, then Grant.
4. Run now: show the change verified, and the product in the Shopify admin now set to stop selling.
5. Price Keeper in review mode: upload the price-list CSV, approve one change, show it verified.
6. Connections: connect the test mailbox, create a draft supplier email, approve it, and show
   "Accepted by provider".
7. Pause the agent; uninstall; show that the store data is deleted after `shop/redact`, as explained on the
   support page.

## 4. Testing instructions for reviewers (paste into the submission form)

> Deploi needs no separate login: it opens inside your Shopify admin after you approve the permissions.
>
> To see each correction, prepare your test store:
> 1. **Overselling:** pick a product with tracked inventory, set its available quantity to 0 and tick "Continue
>    selling when out of stock". Open Deploi → Overview → Run scan. The variant appears under Issues.
> 2. **Agent:** Agents → Create agent → type "Stop out-of-stock products from selling, except products tagged
>    pre-order. Fix it automatically, every 6 hours." → review → Grant → Run now. The change shows as Verified,
>    and the variant in Shopify now stops selling.
> 3. **Price:** Agents → Create agent → "Keep prices matching my price list; ask me before each change" → upload
>    a CSV with the columns `sku,price` (one row with an existing SKU and a new price) → Grant → Run now →
>    approve the proposed change.
> 4. **Publication / SKU:** same pattern with `product_handle,published` (yes/no, for one sales channel you
>    pick) or `barcode,sku`.
> 5. **Email (optional):** Connections → Connect Gmail → sign in with the test mailbox below → create an agent
>    with "email my supplier when stock is low" → approve the drafted message.
>    Test mailbox: `<address>` / `<password>`. It is exempt from 2-step verification and only emails the
>    test recipient `<address>`.
>
> Changes are enabled for every store during review. If a screen says "Deploi is in beta", enter the invite
> code `<code>` (Overview → Invite code).
> To remove the app, uninstall it from Settings → Apps. Store data is deleted when Shopify sends `shop/redact`.

Before pasting:
- fill the mailbox credentials (see blockers);
- create a reviewer invite at `/staff/store-access` (30 days, 5 uses) and paste its code;
- check that every step works on a development store.

## 5. Every remaining submission blocker

| # | Blocker | Who | Status |
|---|---|---|---|
| 1 | Shopify Partner account, a **public** app in the Dev Dashboard, the client ID and secret | you | not started; nothing in this environment |
| 2 | **Real development-store test** of install, the full merchant workflow, uninstall and reinstall | me, once 1, 3 and 4 exist | **not done**; there are no Shopify credentials here, and there is no deployed environment with the new schema |
| 3 | A deployed environment for the app URL, with migrations `…028`–`…032` applied and the env vars set | you approve; I can run it | production database not migrated; production still on the broken deployment |
| 4 | Production domain: `app.getdeploi.com` for the app; `getdeploi.com` for the privacy, support and terms pages | you (DNS) | getdeploi.com DNS still points at the old host |
| 5 | `AUTH_MODE=dev` must be removed from production | you approve | still set |
| 6 | Pricing decision. If paid: plans in Shopify App Pricing, a Partner API token, `SHOPIFY_PARTNER_ID`, `SHOPIFY_PARTNER_APP_ID` | you | undecided; "free during early access" is the draft |
| 7 | Live checks on a development store (each marked UNVERIFIED in the research): whether SKU writes need `write_inventory`; publication read-back; the `partnerDevelopment` value on dev stores; the token refresh cycle; webhook delivery | me, after 2 | open |
| 8 | Gmail / Microsoft for reviewers: OAuth clients, a test mailbox exempt from 2FA, the Google test-user list (or verification) | you | not started. The synthetic mailbox is not available in production. Email is optional; without this, reviewers cannot test it |
| 9 | App icon 1200 × 1200, final screenshots from a dev store, demo screencast | you or a designer; I can script the shots | icon draft ready for sign-off; screenshots are synthetic drafts; no screencast |
| 10 | Emergency developer contact (email and phone), API contact email, confirmed support mailbox | you | not set |
| 11 | Legal review of the privacy policy and terms; the legal entity name in the terms (`VITE_LEGAL_ENTITY`) | you | drafts pending review |
| 12 | App name uniqueness on the App Store | you | no exact match in a web search (closest: "Deployify"); no trademark search done |
| 13 | Shopify's review itself: automated checks, then manual review | Shopify | not submitted; no official timeline |

Known review risks, beyond the blockers:
- **Mailbox OAuth popup:** Google and Microsoft OAuth uses a popup, because those pages cannot be framed and a
  top-level redirect would lose the Shopify session. Best practices discourage popups for essential OAuth;
  mailboxes are optional. UNVERIFIED how reviewers treat it.
- **Look and feel:** the app keeps Deploi's dark theme rather than Polaris. This is allowed for listing, but it
  matters for "Built for Shopify".
