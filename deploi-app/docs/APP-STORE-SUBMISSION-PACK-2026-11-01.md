# Shopify App Store submission pack, 2026-11-01

**Status: not submitted.** This pack updates `APP-STORE-SUBMISSION.md` (2026-10-29) where the code has moved on:
- the app now installs read-only, with write scopes requested at runtime;
- agent email goes through Deploi's own agent mailboxes on Resend. Gmail and Microsoft are off by default.

Blockers are at the end.

## 1. Listing copy (English; no statistics, superlatives, testimonials or prices)

- **App name:** Deploi AI (matches `name` in `shopify.app.toml.example`)
- **Tagline:** Named agents that fix store data you authorize
- **Introduction:** Deploi finds overselling settings, prices, SKUs and channel listings that don't match your rules, and changes them only within the authority you grant.
- **Details:**
  - Describe a job in plain English, for example "keep out-of-stock products from selling, except pre-orders", and Deploi turns it into a named agent with a readable authorization: which products, which single field, which limits, which schedule. Nothing runs until you grant it.
  - Every agent starts at drafts only. You can let it ask before each change, or act on its own within your limits.
  - Each change is checked against a fresh read of the store just before it is made, and confirmed afterwards.
  - Every run, change, failure and approval is kept in a work log with before and after values.
  - Agents can draft supplier restock emails from their own Deploi address. You review each one before it is sent.
- **Feature bullets:**
  - Agents you name, with authorizations you read and grant
  - Stops overselling while respecting pre-order and backorder tags
  - Applies prices, compare-at prices and SKUs from your own files
  - Publishes or unpublishes products on the one channel you choose
  - Review each change, or let an agent act within limits
  - A work log of every change, with before and after values
  - Supplier restock emails you approve before they go out
- **Pricing:** Free during early access. **Your decision**; see `APP-STORE-OPEN-ITEMS.md` §1.
- **Category:** Store management → Inventory management (confirm in the form). **Languages:** English. **Requires Online Store:** No.

## 2. Scopes, each with its reason

Source of truth:
- `lib/connectors/shopify/config.ts`: `REQUIRED_SCOPES`, `OPTIONAL_SCOPES`, `ACTION_SCOPES`;
- `shopify.app.toml.example`: `[access_scopes]`.

No customer, order, report or protected-customer-data scope is requested anywhere.

| Scope | When | Why Deploi needs it |
|---|---|---|
| `read_products` | at install | Read products and variants (title, tags, price, compare-at price, SKU, barcode, "continue selling when out of stock") to find issues and show evidence |
| `read_inventory` | at install | Read available quantities and tracking per inventory item: overselling is "0 available **and** continue selling on" |
| `read_locations` | at install | Inventory levels are per location; summing and explaining them needs the location list |
| `write_products` | at runtime, only when a merchant widens an agent past drafts only | The approved edits: inventory policy (stop selling when out of stock), price, compare-at price, SKU |
| `read_publications` | at runtime, with the publication agent only | See which sales channels a product is published on, for the channel correction |
| `write_publications` | at runtime, with the publication agent only | Publish or unpublish a product on the one channel the merchant picked |

**Unverified on a live store:** whether SKU writes on API `2026-10` need `write_inventory`. The SKU lives on the inventory item. This is listed as blocker 7 in `APP-STORE-SUBMISSION.md`. If they do, add `write_inventory` to the optional scopes in both files before submitting.

## 3. Mandatory compliance webhooks: verified in code and tests; **not working in production**

| Check | Result |
|---|---|
| Declared | `compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]` → `https://app.getdeploi.com/api/shopify/webhooks` |
| HMAC | HMAC-SHA256 over the raw body, constant-time compare; **401** if missing or forged (`lib/connectors/shopify/webhooks.ts`) |
| Duplicates | de-duplicated by `X-Shopify-Webhook-Id`; a failed delivery is processed again on Shopify's retry |
| `customers/data_request`, `customers/redact` | 200 + audit row. The app holds no customer data. |
| `shop/redact` | erases the shop's data, and its organization if that was its only store |
| Tests | `tests/merchant/shopify-routes.test.ts` covers unsigned → 401, forged → 401, both customer topics → 200, duplicate, and redact erasing the shop. `tests/merchant/access.test.ts` covers redact erasing the access record. They pass in the 303/303 run of 2026-11-01. |
| **Live, 2026-11-01** | Unsigned POSTs of all three topics to production returned **503** `webhook secret not configured`. `SHOPIFY_API_SECRET` exists only on the Preview branch `claude/jolly-ptolemy-kp7ljd`, not in Production. Shopify's automated check expects **401** for a bad HMAC, so this fails review until the production app's secret is set. |

## 4. Privacy policy URL

- **URL for the form:** `https://getdeploi.com/privacy`. Terms: `https://getdeploi.com/terms`. Support: `https://getdeploi.com/support`.
- **Live, 2026-11-01:** those URLs return Squarespace's "Coming Soon" page (HTTP 200, `<title>Coming Soon`), not the policy. They serve the real pages once the DNS in `DNS-GETDEPLOI-PASTE.md` is applied, because the domains are already attached to Vercel project `deploi-site`.
- The policy shows "Draft, pending legal review" until `VITE_LEGAL_REVIEWED=true`. The counsel points are in `APP-STORE-OPEN-ITEMS.md` §5. Add **Resend** to the sub-processors (agent and system email).

## 5. Screenshot set

Drafts, 1600 × 900, real UI, produced on 2026-11-01:
- run `E2E_SCREENS_DIR=… npx playwright test e2e/embedded.spec.ts` against a local production build;
- on the synthetic store;
- files in `docs/app-store/screenshots-draft-2026-11-01/`.

| # | File | Alt text |
|---|---|---|
| 1 | `listing-overview.png` | Store overview: agents, email and issues at a glance |
| 2 | `listing-agents.png` | Named agents with their permission level and schedule |
| 3 | `listing-issues.png` | Store issues, each with its evidence |
| 4 | `listing-connections.png` | Store and mailbox connections with their permissions |

Still needed for the final set (Shopify allows 3–6):
- **Retake on a development store in the real admin.** The drafts show "(synthetic)" and "Synthetic test store" labels, which must not appear in the listing.
- Add two screens: the authorization summary before Grant, and a proposed change with its evidence.

## 6. Blockers to submit (in order)

1. Partner account and a **public** app in the Dev Dashboard. Its client ID and secret go in Vercel **Production** as `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`. This also fixes the 503 in §3.
2. DNS from `DNS-GETDEPLOI-PASTE.md`, so the privacy, terms and support URLs serve the real pages.
3. A test on a real development store: install → agent → grant → change verified → uninstall → `shop/redact`. Retake the screenshots there.
4. Decide on pricing; sign off the icon (`docs/app-store/icon-1200.jpg`); legal review; set the emergency contact (email and phone).
