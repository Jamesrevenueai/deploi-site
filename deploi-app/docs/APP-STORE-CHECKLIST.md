# Shopify App Store listing checklist, and private beta install links

Status as of 2026-10-28. ✅ ready in the repo · 📝 drafted, needs your review · ⛔ needs you or a third party.

## 1. Before submitting

| Item | Status | Where / what remains |
|---|---|---|
| App configuration (scopes, URLs, webhooks, GDPR compliance topics) | ✅ | `shopify.app.toml.example`: least-privilege scopes (`read_products, write_products, read_inventory, read_locations, read_publications, write_publications`); no customer or order scopes. Copy it to `shopify.app.toml` with the real client ID and handle, then run `shopify app deploy`. |
| Embedded app, App Bridge, session tokens | ✅ code · ⛔ live | `/shopify/*` pages. **Not yet verified on a development store** (READINESS-REPORT §3). |
| Mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) | ✅ | `app/api/shopify/webhooks`; HMAC-verified. |
| Billing through Shopify | ⛔ | Shopify App Pricing plans are set in the Partner Dashboard. No prices are decided, and Partner API credentials (`SHOPIFY_PARTNER_*`) are not set. `BILLING_REQUIRED` stays `false` until then (`lib/connectors/shopify/billing.ts`). |
| Pricing on the listing | ⛔ | Decide the plans (for example a free trial plus one or two paid tiers), then enter the same values in Partner Dashboard → App Pricing. |
| Listing copy | 📝 | Draft below (§3). |
| App icon, 1200×1200 PNG/JPG, no text, no screenshots | ⛔ | Not made yet. Keep it simple: the wordmark mark on black. |
| Screenshots / feature media (1600×900 desktop) | 📝 | Use the screens in `proof/platform-*-1440.png` after the dev-store run, recaptured on a real store rather than the synthetic one. |
| Demo screencast (required for review) | ⛔ | Record on the development store. Script: install → create an agent from a template → read the authorization → grant at drafts only → run → drafted changes → widen to "after approval" (new grant) → approve one change → Verified → work log → pause and revoke. |
| Privacy policy URL | 📝 | `https://getdeploi.com/privacy`. Covers corrections, connected email and agent addresses. It shows "Draft, pending legal review" until `VITE_LEGAL_REVIEWED=true`. **Needs counsel.** |
| Terms of service URL | 📝 | `https://getdeploi.com/terms`, same legal review. |
| Support email / emergency contact | ⛔ | `hello@getdeploi.com` is used today. Its mail fails DMARC until DNS step B2 in `LAUNCH-DNS.md` is done. Add an emergency phone in the Partner Dashboard. |
| Reviewer test credentials | ⛔ | Shopify reviews on its own development store. Provide: the steps above, a sample price list, SKU mapping and publication list (`lib/connectors/shopify/demo-store.ts` has the formats), and note that email sends are off unless `EMAIL_LIVE_SENDS` is set. |
| Production readiness | ⛔ | Migrations 28–32 applied to production (`scripts/launch-migrations.ts`, with your approval), dev auth removed from production (`PRODUCTION-SAFETY.md`), PR #1, PR #2 and this PR merged, and live dev-store verification passed. |
| Performance (Web Vitals for embedded apps) | ⛔ | Measure on the dev store after deployment. |

## 2. Private beta: custom install link per merchant

Until the listing is approved, a real (non-development) store can install the app only through **custom distribution**. This is a Shopify rule; confirm the current wording in the Partner Dashboard before relying on it.

1. Partner Dashboard → Apps → create a **separate app per beta merchant** for custom distribution (custom distribution is limited to one store, or one Plus organization, per app). Use the same `application_url` and scopes as the public app.
2. App → Distribution → **Custom distribution** → enter the merchant's `*.myshopify.com` domain → **Generate link**. Shopify's link looks like `https://admin.shopify.com/oauth/install_custom_app?client_id=…&signature=…`. Send it to the merchant; it installs only on that store.
3. In Deploi, add the store to `LIVE_WRITE_STORES` (comma-separated `*.myshopify.com`). Without it, no write is ever made to a live store, whatever an agent's permission level.
4. The merchant's agents start at drafts only. Widening is the merchant's own grant.
5. Record the beta store and link in your CRM. Revoke access by uninstalling the app or removing the store from `LIVE_WRITE_STORES`, which blocks writes immediately.

Development stores (Partner Dashboard → Stores) can install the unreviewed public app directly. Use one for the reviewer flow and the demo.

## 3. Listing copy (draft)

- **App name:** Deploi AI
- **Tagline (≤ 62 chars):** AI agents that fix stock and listing problems, with your OK
- **Intro:** Create agents that watch your store for overselling, publication, price and SKU problems. Each agent starts at drafts only: it shows you the exact change it would make. You decide when it may make changes after your approval, or without asking within limits for up to a year. Every change is re-read to confirm it took effect.
- **Features:**
  1. Agents from plain English or from templates: Inventory Watcher, Supplier Chaser, Store Health Checker.
  2. Three permission levels for every tool: drafts only, after your approval, without asking within limits.
  3. Every change is verified by a fresh read, and every action is in a work log that shows the permission that allowed it.
  4. Each agent can have its own email address for supplier follow-ups, with no access to your mailbox.
  5. A weekly summary of what your agents did and what needs you.
- **What it never does:** change stock counts, change product status, delete products, invent prices or SKUs, or read customer or order data.
- **Data access statement:** products, variants, inventory levels and locations (read); products and publications (write, only for authorized corrections). No customer or order data.
