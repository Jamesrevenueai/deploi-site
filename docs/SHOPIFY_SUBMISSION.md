# Shopify App Store submission package: "Deploi"

Prepared 2026-11-24. Paste-ready copy lives in `docs/SHOPIFY_LISTING.md` (app name, URLs, scopes, data use); this file
adds the AI Visibility–led listing copy, keywords, screenshots, demo video script, reviewer instructions and the
self-audit. **Status: NOT ready to submit.** The self-audit (§7) has 6 FAILs; each names who fixes it.

## 0. Read first: what the app actually shows inside Shopify at launch

Shopify rejects listings that describe features a reviewer cannot find in the installed app. Inside the Shopify admin,
the app currently offers **3 agents**: Inventory Watcher, Supplier Chaser, Store Health Checker
(`lib/shopify/embedded.ts`, `EMBEDDED_TEMPLATES`). The other 9 library agents, **including AI Visibility**, are
hidden there because their live-store reader is not wired, and 5 of them (Order Tracker, Returns, Customer Care,
Weekly Insights, Payout & Fees) also need protected customer data scopes that the first submission does not request.

So there are two versions of the listing below:
- **§1A (requested): leads with AI Visibility.** Use it only after AI Visibility is reachable in the embedded app.
  AI Visibility needs no protected scopes (`agent-library.json`: `protectedScopes: []`), so it is the cheapest one to
  turn on: it needs the live store reader wired and the agent marked `shopifyReady`.
- **§1B (submit-safe today): leads with what is live.**

## 1A. Listing copy, AI Visibility first (use when AI Visibility is live in the app)

**App name:** Deploi
**Tagline (≤ 62 chars):** Get found by AI shoppers. Agents fix your store for you.

**Introduction (≤ 100 chars):**
Shoppers now ask AI assistants what to buy. Deploi makes your products easy for them to find and trust.

**Details:**
Deploi gives your store a small team of AI agents, each with one job. They watch your store, fix what they are allowed
to fix, and show you proof of every change.

- **AI Visibility:** finds products that AI shopping assistants struggle to read (missing descriptions, image alt
  text, unclear titles and SEO fields) and drafts the fixes in your voice.
- **Inventory Watcher:** stops products selling past zero and warns you before best sellers run out.
- **Supplier Chaser:** drafts the follow-up when a restock is late.
- **Store Health Checker:** finds broken or incomplete product pages.

You stay in charge: every agent starts with drafts only. Each change waits for your one-tap approval until you
decide an agent may act on its own, and every action has a before/after record.

**Key features (3):**
1. Agents that read your products and fix what is wrong, with proof.
2. You approve changes in one tap; nothing changes without your rules.
3. Built for AI shopping: product data that assistants can read.

## 1B. Listing copy, submit-safe today

**Tagline:** AI agents that keep your products selling, with proof.
**Introduction:** Deploi agents watch your products and stock, fix problems and show you what they did.
**Details:** as §1A without the AI Visibility bullet and without key feature 3; replace key feature 3 with
"Stops overselling: products that hit zero stop selling until you restock."

## 2. Keywords (5 search terms)

AI visibility · inventory · out of stock · store automation · product SEO

(§1B: replace "AI visibility" with "overselling".)

## 3. Screenshots (1600 × 900, real UI, no browser frame, no personal data)

All six are in `docs/listing-screenshots/`, captured 2026-11-24 from the embedded app (`e2e/embedded.spec.ts` with
`E2E_SCREENS_DIR`), every one checked at exactly 1600 × 900:

| # | File | Caption |
|---|---|---|
| 1 | `listing-overview.png` | See every problem your agents found, and what they fixed |
| 2 | `listing-agents.png` | One agent per job, each starting with drafts only |
| 3 | `listing-approvals.png` | Approve a change in one tap; nothing changes without you |
| 4 | `listing-issues.png` | Every issue with the products it affects |
| 5 | `listing-activity.png` | A record of every action, with before and after |
| 6 | `listing-connections.png` | Connect your store once; Deploi checks it continuously |

**Limit:** these were captured against a local build with a stand-in Shopify admin and synthetic store data, and
#3 is an empty state. Retake all six inside the real admin on james-jwtftl1e once item 4 (dev-store E2E) runs, so they
show real work. Same command, `E2E_BASE_URL` pointed at the dev-store host.

## 4. Demo video script (≈ 80 seconds, screen recording inside the Shopify admin)

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:08 | Shopify admin → Apps → Deploi opens on Overview | "This is Deploi, a team of AI agents that keep your store selling." |
| 0:08–0:20 | Agents page: Inventory Watcher, Supplier Chaser, Store Health Checker | "Each agent has one job. They all start with drafts only, so nothing changes until you say so." |
| 0:20–0:35 | Run scan → a product selling at zero stock appears as an issue | "Here Inventory Watcher found a product that keeps selling with no stock." |
| 0:35–0:50 | Approvals → open the change → Approve | "It prepared the fix. I approve it in one tap." |
| 0:50–1:02 | Product page in Shopify shows "Continue selling when out of stock" off | "Deploi made exactly that change, then read the store again to prove it worked." |
| 1:02–1:15 | Activity: the before/after record | "Every action is logged with its proof." |
| 1:15–1:22 | Agent page: permission level | "When you trust an agent, let it act on its own. Money and publishing always wait for you." |
| 1:22–1:28 | Logo | "Deploi. Free to install." |

(When AI Visibility is live, swap 0:20–1:02 for an AI Visibility finding and its approved fix.)

## 5. Reviewer instructions (paste into "Testing instructions")

1. Install Deploi on your development store. Installation is Shopify-managed; no separate account or password is
   needed. The app authenticates with Shopify session tokens.
2. The app opens on **Overview**. Click **Run scan**.
3. To see a finding, set any product's inventory to 0 with **Continue selling when out of stock** turned on, then
   **Run scan** again. Inventory Watcher reports it under **Issues**, with a fix waiting in **Approvals**.
4. Open **Approvals** and approve the change. The product's setting changes. **Activity** shows the before/after record.
5. **Agents** lists the three agents; open one to see its permission level. Every agent starts at drafts only.
6. The app is free. It makes no Billing API calls.
7. Contact during review: support@getdeploi.com.

**Test login:** none is needed for the embedded app. Production runs with `STORE_ACCESS_MODE=review`, which admits
development stores (and staff-approved stores), so a reviewer's development store can install. The separate web
app at app.getdeploi.com uses an emailed one-time sign-in link, with no passwords, and is not part of the Shopify review.

## 6. URLs (checked live 2026-11-24, HTTP status)

| Field | URL | Status |
|---|---|---|
| Privacy policy | https://getdeploi.com/privacy | 200 |
| Terms of service | https://getdeploi.com/terms | 200 |
| Support / FAQ | https://getdeploi.com/support | 200 |
| Developer website | https://getdeploi.com | 200 |
| App URL | https://app.getdeploi.com/shopify | 200 |

## 7. Self-audit against the App Store requirements

| # | Requirement | Result | Evidence / who fixes it |
|---|---|---|---|
| 1 | Production app exists, separate from the dev app | **FAIL** | CLI service account refused: "User does not have access to create_app". Founder creates "Deploi" in the Dev Dashboard (FOUNDER_ACTIONS §A). `deploi-app/shopify.app.production.toml` is ready to link and deploy. |
| 2 | IP allowlist set (required for public apps since 2026-11-20) | **FAIL** | UI-only setting. Founder sets ASN 16509 + 14618, country US, Run test, on Deploi and Deploi (dev) (FOUNDER_ACTIONS §B). |
| 3 | Production has the Shopify keys | **FAIL** | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_API_VERSION`, `SHOPIFY_APP_HANDLE` missing (docs/ENV_PREFLIGHT.md). |
| 4 | Listing describes only what the app does | **FAIL for §1A / PASS for §1B** | AI Visibility is not in the embedded app yet (§0). |
| 5 | Works end to end on a development store | **FAIL (blocked)** | Dev-store harness reaches its database: "tenant/user postgres.bhddgjcefwasdyrrfptc not found". The preview Supabase project looks paused or removed. Founder restores it. |
| 6 | Screenshots from the real app with real data | **FAIL** | Six 1600 × 900 drafts exist (§3); retake on the dev store after #5. |
| 7 | Embedded with the latest App Bridge (first script, from cdn.shopify.com) | PASS | `e2e/embedded.spec.ts` 4/4 (2026-11-24) |
| 8 | Session-token auth; a wrong token is refused | PASS | `e2e/embedded.spec.ts` "wrong secret is refused" |
| 9 | Shopify-managed install, no legacy flow | PASS | `shopify.app.production.toml` (no `use_legacy_install_flow`) |
| 10 | Mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) | PASS | Declared in the TOML; HMAC-verified, unsigned → 401 (`tests/shopify/webhooks.test.ts`) |
| 11 | `app/uninstalled` handled | PASS | Declared; handler covered in `tests/merchant/shopify-routes.test.ts` |
| 12 | Minimum scopes; no protected customer data requested | PASS | `read_products, write_products, read_inventory, read_locations, read_discounts`; optional publications asked for at runtime |
| 13 | Charges only through Shopify (no outside payment for Shopify merchants) | PASS | Free at launch; Stripe refuses Shopify-billed stores (`use_shopify_billing`); `tests/billing/free-at-launch.test.ts` 6/6 |
| 14 | Pricing in listing matches the app | PASS (listing) / **check** (site) | Listing: Free. getdeploi.com/pricing shows the future paid Store plans; reviewers may compare. Decide whether the site shows "Free during launch" until billing is on. |
| 15 | Privacy policy, terms, support URLs live | PASS | §6 |
| 16 | App name consistent (≤ 30 chars, no "Shopify") | PASS | "Deploi" in the TOML and listing |
| 17 | Frame limited to the admin (CSP `frame-ancestors`) | PASS | `e2e/embedded.spec.ts` |
| 18 | Accessible admin UI | PASS | axe 0 violations on the app screens (2026-11-23, `proof/rebuild-2026-11-23/app/axe.json`) |
| 19 | Demo video | TODO | Script in §4; record after #5 |
| 20 | Support contact answers | **check** | support@getdeploi.com: Resend/DNS for getdeploi.com not verified yet (FOUNDER_ACTIONS §3) |
