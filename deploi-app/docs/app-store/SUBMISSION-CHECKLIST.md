# Shopify App Store submission checklist: Deploi AI

Audit date 2026-11-06, branch `claude/launch-w5`. The requirements were fetched from shopify.dev the same day:

- "App Store requirements"
- "Pass app review"
- "Submit your app for review"
- "Best practices → App listing"
- "Privacy law compliance"
- "Protected customer data"
- "Billing"
- "Revenue share"
- "Select a distribution method"

Items marked **from docs** were checked against those pages. Items marked **to confirm** are not on those pages: check them in the Partner Dashboard.

Status: **PASS** = verified in code and tests here · **FAIL** = a gap that blocks submission ·
**FOUNDER** = needs you (a decision, an account step or a live check). "Live" means on a real development store
with the production app. **No item below has been verified live**: no Shopify credentials exist in this environment.

## A. Code requirements (from docs)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1.1.1 | Session tokens; works without third-party cookies or local storage (incognito) | PASS (local) | `lib/store/request.ts#resolveActor` (bearer id token, HS256, aud/exp/nbf/iss=dest); `lib/connectors/shopify/auth.ts#verifySessionToken`; 401 + `X-Shopify-Retry-Invalid-Session-Request` (`request.ts:94`). Every `app/api/store/**` route uses it: `tests/shopify/app-store-requirements.test.ts` "1.1.1". sessionStorage is only a try/catch convenience (`components/store/Overview.tsx:23`). e2e `embedded.spec.ts` "wrong secret". |
| 1.2.1–1.2.3 | Shopify billing only; accept/decline/re-approve on reinstall; allow plan changes | PASS (local) if listed Free · FOUNDER if paid | App Pricing: `lib/connectors/shopify/billing.ts` (Partner API `activeSubscription`, hosted plan page `pricingPlansUrl` at `admin.shopify.com`, opened `_top`). Uninstall cancels the subscription record (`install.ts#markUninstalled`). **New:** embedded Plan page `/shopify/plan` (shown only when `BILLING_REQUIRED=true`) with "Change plan in Shopify" (`components/store/ShopifyPlan.tsx`). **New:** a plan handle equal to a `plans.key` sets the org's plan and tier (`billing.ts`, test "an App Pricing plan whose handle…" in `tests/merchant/app-store.test.ts`). Stripe is refused for Shopify-billed stores (`lib/billing/checkout.ts:65`); the library tier API answers 404 inside Shopify. |
| 2.1.1–2.1.3 | No 404/500/300 web errors; usable UI | PASS (local) | **New gating:** the menu lists only ready features, so no menu entry leads to a 404 (`lib/shopify/embedded.ts`, `tests/shopify/embedded-gating.test.ts`, e2e "only ready features are reachable"). Hidden routes answer 404 only when typed by hand. |
| 2.2.1 / 2.2.4 | Uses Shopify APIs; GraphQL Admin API only | PASS | `lib/connectors/shopify/client.ts:33` (`graphql.json`, version 2026-10); no REST calls in `lib/`. |
| 2.2.2 | Consistent embedded experience | PASS (local) | All merchant features used inside Shopify exist under `/shopify/*`. **New:** Privacy requests (`/shopify/privacy`) and Agreements (`/shopify/legal`, shown while `LEGAL_GATE` is on). Before this, a Shopify-only merchant could not download a customer data export or accept agreements. |
| 2.2.3 | Latest App Bridge before any other script | PASS (local) | `app/layout.tsx` (CDN script); `middleware.ts:69` `appBridgeFirst`; e2e checks the first `<script>`. |
| 2.3.1–2.3.4 | Install from Shopify, OAuth immediately, land in UI, same on reinstall | PASS (local) · FOUNDER live | Managed install + token exchange on first load (`app/api/shopify/session/route.ts`, `install.ts#ensureInstalled`; reinstall reactivates). No shop-domain input inside Shopify (`Connect.tsx` hides it when embedded). `tests/merchant/shopify-routes.test.ts`. |
| 3.1.1 | Valid TLS | PASS | `app.getdeploi.com` serves HTTPS (health 200, 2026-11-06); HSTS in `next.config.ts`. |
| 3.1.2 | Expiring offline tokens | PASS (local) | `auth.ts:121,127` `expiring: '1'`; refresh with rotation; `tests/merchant/app-store.test.ts` "tokens". |
| 3.2 | Minimal scopes; optional scopes for non-universal needs | PASS | Required `read_products, read_inventory, read_locations`; optional `write_products, read_publications, write_publications` (`shopify.app.toml.example`, `lib/connectors/shopify/config.ts`). No protected scope: test "3.2 scopes". |
| Privacy | Compliance webhooks subscribed; 401 on bad HMAC; 200 on receipt; act within 30 days | PASS (local) | TOML `compliance_topics`; `webhooks.ts:38` (401), dedupe by webhook id, 500 so Shopify retries on failure (`webhooks.ts:105`). Work is done before the reply, measured under 2 s (`app-store-requirements.test.ts` "answers 200 well inside…"). Shopify allows 5 s. If a reply is slow, Shopify's retry is answered as a duplicate once the first run finishes. `customers/data_request` → encrypted export for the merchant (now reachable inside Shopify); `customers/redact` erases per table; `shop/redact` erases the shop, or is deferred if it reinstalled (`install.ts:124`). |
| Uninstall | Stop everything on `app/uninstalled` | PASS (local) | `install.ts#markUninstalled`: connection off, token deleted, proposals blocked, agents paused, email cancelled, subscriptions cancelled. Test "app/uninstalled stops everything". |
| Framing | CSP `frame-ancestors` per shop | PASS (local) | `middleware.ts:15`; e2e checks the header. |
| Gating | Only working features visible in review | PASS (local) | `lib/shopify/embedded.ts` + `lib/store/embedded-gate.ts`. Hidden: Team/library agents (live store reader not wired), build-your-own, library tiers, Supplier Coordinator and purchase orders, Competitor & Trend Watcher. Proof: `tests/shopify/embedded-gating.test.ts` (every page declared and gated; hidden pages 404; the API answers 404 to a Shopify token; the web app is not gated), e2e. |

## B. Listing and submission (from docs unless marked)

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| 4.1 | Name ≤ 30, brand-led, same as TOML | PASS | "Deploi AI"; test "4.1 name and URLs". |
| 4.2 | Pricing only in the pricing section, accurate | FOUNDER | `LISTING.md` §3: Free recommended; prices are hypotheses. |
| 4.3–4.4 | No stats/superlatives/testimonials; subtitle, intro ≤ 100, details ≤ 500, features ≤ 80 | PASS (draft) | `LISTING.md` §2 (counted). |
| 4.4.3–4.4.5 | Icon 1200×1200, no text or Shopify marks; 3–6 screenshots 1600×900, unique | FOUNDER | Icon draft `docs/app-store/icon-1200.jpg` (approve). Screenshots: capture on a development store (`LISTING.md` §6). |
| 4.5.3 | Demo screencast, English | FOUNDER | Script in `LISTING.md` §7. Record it. |
| 4.5.4–4.5.5 | Test instructions; no 2FA-blocked logins | PASS (draft) · FOUNDER verify | No separate login. Instructions in `LISTING.md` §8. Run them first. |
| 4.5.6 | Emergency developer contact (email + phone) | FOUNDER | Partner Dashboard → Settings. |
| Privacy URL | Required, must load | **FAIL** | getdeploi.com serves a parking page ("Coming Soon"). `/privacy`, `/terms`, `/support` are not live. The policy is a draft pending legal review. |
| Support email | Monitored, not another company's | **FAIL → FOUNDER** | Choose a Deploi address (§C.4). The previous support address (another company's) must not appear. |
| Protected customer data | Request or opt out | PASS (decision) | Opt out: `PROTECTED-CUSTOMER-DATA.md` §1. |
| Registration fee | One-time **$19 USD** per Partner account to register with the App Store (needed for the revenue share plan) | FOUNDER | From docs ("Revenue share"). Revenue share: 0% on the first $1,000,000 USD lifetime, 15% above, plus a 2.9% processing fee. |
| Distribution | Public (App Store); permanent | FOUNDER | From docs: the method can't be changed after you select it. |
| Production config | Env and migrations | FOUNDER | `STORE_ACCESS_MODE=open` (so reviewers see no beta card and can make changes); `EMAIL_LIVE_SENDS=off` during review (matches the instructions); `LEGAL_GATE` off, or published texts (the embedded Agreements page appears when on); `BILLING_REQUIRED=false` if Free; migrations applied through the current release set. |
| Live dev-store run | Every flow on a real store | **FAIL (not done)** | `docs/APP-STORE-OPEN-ITEMS.md` §6 steps 1–9. Nothing has run against Shopify yet. Review fails on any 404/500 a live store reveals. |

## C. Founder steps, in order (Partner Dashboard / Dev Dashboard labels as of 2026-11-06)

1. **Register for the App Store (to confirm the price in the dashboard):** Partner Dashboard → **Settings** →
   Organization → **App Store registration** → **Register** → business details → **Pay now** ($19 one-time).
   This needs the Organization owner or admin role.
2. **App configuration:** `shopify app config link` against the production app. Copy `shopify.app.toml.example`
   to `shopify.app.toml`, fill in `client_id` and `handle`, then `shopify app deploy`. In the Dev Dashboard →
   app → **Versions**, open the active version and check:
   - App URL `https://app.getdeploi.com/shopify`
   - redirect URL `.../api/shopify/auth/callback`
   - the 3 compliance topics
3. **Distribution:** Dev Dashboard → app → **Distribution** card → **Select distribution method** → **Public
   distribution (Shopify App Store)** → confirm. This is permanent.
4. **Support email:** create **support@getdeploi.com**, a mailbox or alias delivered to you.
   1. At the DNS host, add SPF and DKIM for the mail provider and a DMARC record (`docs/LAUNCH-DNS.md`).
   2. Send a test from an outside account and reply to it.
   3. In this repo, set `CONTACT_EMAIL` in `src/lib/brand.ts` and `COMPANY_EMAIL` in `deploi-app/lib/env.ts` to
      it, and `SUPPORT_INBOX` in production. Redeploy.
   4. Use it as the listing's support email and as the API contact email (it must not contain "shopify").
5. **Website live:** point getdeploi.com at the site build (`docs/LAUNCH-DNS.md`). Then confirm that `/privacy`,
   `/terms` and `/support` load. Get counsel's sign-off on privacy and terms, then set `VITE_LEGAL_REVIEWED=true`.
6. **Emergency contact:** Partner Dashboard → **Settings** → emergency developer contact (email and phone).
7. **Production environment:** set the values in §B "Production config" (Vercel project, production).
8. **Live run on a development store:** Partner Dashboard → **Stores** → **Add store** → development store.
   Dev Dashboard → app → **Install app** → choose it. Then run `docs/APP-STORE-OPEN-ITEMS.md` §6 steps 1–9 and
   `LISTING.md` §8 steps 1–7. Record each result. Fix anything that fails before you submit.
9. **Assets:** approve the icon; capture 3–6 screenshots (`LISTING.md` §6); record the screencast (§7).
10. **Pricing:** decide Free or paid (`LISTING.md` §3). If paid, create the App Pricing plans with handles
    `starter`/`growth`/`pro` and test choose, upgrade, downgrade and cancel on the development store (no charge there).
11. **App Store review page** (Partner Dashboard → Apps → Deploi AI → **Distribution** → **Manage submission** /
    review page):
    1. Configuration: URLs, compliance webhooks, icon, API contact email.
    2. Listing: paste `LISTING.md` §1–§5, upload the screenshots with alt text.
    3. Protected customer data: **opt out**.
    4. Run the **automated checks** until they pass.
    5. Testing instructions: paste `LISTING.md` §8 and attach the screencast.
    6. Submission contact email: add `noreply@shopify.com` to your allowed senders.
    7. **Submit**.

## D. Summary

- Code: every item in §A passes locally. Five fixes are new in this branch: embedded gating, Privacy and
  Agreements inside Shopify, the embedded Plan page, plan-handle entitlements, and the layout-level 404.
- Not code: privacy policy and support URLs (site not live), support email, live dev-store verification,
  icon/screenshots/screencast, pricing decision, registration, emergency contact.
- **Earliest submission:** as soon as §C steps 4, 5 and 8 are done. Step 8 is the long pole: it depends on the
  live run passing without new defects.
