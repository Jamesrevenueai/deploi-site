# WooCommerce setup and live test

Deploi Commerce connects to a WooCommerce store through the WooCommerce REST API v3 (`/wp-json/wc/v3`),
with a consumer key pair the merchant approves. It uses the same engine, agents, permission tiers,
approvals, verification and audit trail as Shopify.

**Status:** built and tested against a synthetic WooCommerce store and a fake HTTP layer.
**Live verification: blocked.** It needs a WooCommerce store with HTTPS and an administrator (or shop
manager) to approve keys. No real WooCommerce credentials were used to build or test this connector.

## What Deploi reads and writes

| | |
|---|---|
| Reads | products and variations (stock, backorders, prices, SKU, status, tags, slug, GTIN), `system_status` (WooCommerce and WordPress version), settings `woocommerce_manage_stock`, `woocommerce_notify_low_stock_amount`, `woocommerce_currency`, the site name and timezone (`/wp-json/`) |
| Writes (one field per request, only after approval or within a granted authorization) | `backorders`, `regular_price` or `sale_price`, `sku`, `status` between `draft` and `publish` only |
| Never | stock quantities, customers, orders, deleting products, pending/private/scheduled/trashed products, starting or ending a sale |
| Webhooks | `product.updated`, `product.deleted`, `order.created`, created on connect with a per-connection secret, deleted on disconnect |

Every write: fresh read (bypassing the REST cache with `_skip_cache`), precondition check, one `PUT`,
verification by another fresh read. A lost answer is recorded as unknown and settled by the fresh read;
it is never sent again automatically.

## Requirements

- The store: WordPress with WooCommerce 3.5 or newer (9.2+ for GTIN matching), served over **https**
  on port 443, on a public domain name, with permalinks not set to "Plain".
- The person connecting: a WordPress administrator or shop manager (`manage_woocommerce`).
- Deploi: `CREDENTIALS_ENCRYPTION_KEY` and `APP_SECRET` set; for the approval flow and webhooks,
  `NEXT_PUBLIC_APP_URL` must be the public **https** address of Deploi (WooCommerce refuses to send keys to
  an http callback). Without https, the page offers only "Paste API keys" and webhooks stay off (changes
  are then picked up on each scan).
- Database migration `20261104000038_woocommerce.sql` applied (rollback in `supabase/rollback/`).

## How a merchant connects

`/store/connect` → **Connect WooCommerce** → `/store/connect/woocommerce`.

1. **Approve in WooCommerce (recommended).** Enter the store address and continue. Deploi sends the browser
   to `https://<store>/wc-auth/v1/authorize?app_name=Deploi&scope=read_write&user_id=<one-time state>&return_url=…&callback_url=…`.
   The merchant approves; WooCommerce creates a key named "Deploi - API (date)" and POSTs it to
   `/api/woocommerce/callback`. Deploi checks the state (signed, one-time, 30-minute expiry, bound to the
   organization and the store address), requires `read_write`, encrypts the key and answers 200; any
   other answer makes WooCommerce delete the key. Deploi then validates the key with a live read,
   creates the connection, registers webhooks and runs the first scan. The browser returns to the page.
2. **Paste API keys (fallback).** In wp-admin: WooCommerce → Settings → Advanced → REST API → Add key,
   permission **Read/Write**. Paste the consumer key and secret. Deploi validates them with a live read
   before storing anything.

A store already connected to another Deploi organization is refused. Addresses that are not https, are IP
literals, or resolve to private, loopback, link-local or otherwise non-public addresses are refused
before any request is sent. Redirects are never followed with the key attached.

**Disconnect** deletes Deploi's webhooks from the store and Deploi's copy of the key, and stops every
agent, proposal and queued write on the store. WooCommerce has no API to revoke a key: the merchant
should also delete the "Deploi" key in WooCommerce → Settings → Advanced → REST API.

## Founder live test (exact steps)

Use a store you own (a staging copy of a real store, or a fresh WordPress + WooCommerce on any https host).
Do not use a customer's production store for the first run.

1. **Prepare the store.** WooCommerce ≥ 3.5, https, permalinks "Post name". Create test products:
   - "Test Board": simple, Manage stock on, Stock 0, Backorders "Allow, but notify", price 42.00, SKU `T-BOARD`
   - "Test Apron": simple, Manage stock on, Stock 5, price 28.00, no SKU
   - "Test Mug": simple, status **Draft**, price 16.00, SKU `T-MUG`
   - "Test Tote": variable with Size Small/Large, each variation managing its own stock (Small: 0 with
     backorders "Allow"; Large: 9), prices 22.00 / 26.00.
2. **Deploy Deploi on https** (a preview deployment is fine) with `NEXT_PUBLIC_APP_URL` set to that https
   address, `CREDENTIALS_ENCRYPTION_KEY`, `APP_SECRET` and the database migrated.
3. **Enable writes for the store.** Beta access applies to WooCommerce stores too: after connecting, redeem a
   beta invite created without a shop domain (invites bound to a domain accept only `*.myshopify.com`), have
   staff approve the store, or run with `STORE_ACCESS_MODE=open` on the test deployment.
   Make sure `LIVE_WRITES` is not `off`.
4. **Connect.** Sign in as a merchant → `/store/connect/woocommerce` → enter the store address →
   "Continue to WooCommerce" → approve. Expected: back on the page with "Connected", WooCommerce version
   shown, "3 active" webhooks. In wp-admin → WooCommerce → Settings → Advanced → REST API there is a
   "Deploi" key (Read/Write); under Webhooks there are three "Deploi: …" webhooks.
   Repeat once with "Paste API keys" on a second key to test the fallback.
5. **Scan.** Run a scan (Store page). Expected issues: backorders at zero on Test Board and Test Tote / Small
   (only if the "Taking backorders against your rule" rule is on), nothing for Test Apron.
6. **Review-mode agent.** Create an agent: overselling configuration, all products, "After my approval".
   Run it; approve the Test Board change. Expected: execution **verified**; in wp-admin the product now
   shows Backorders "Do not allow" and stock status "Out of stock".
7. **Authorized agent.** Upload a price list (`sku,price` with `T-MUG,18.00`), a SKU mapping
   (`variant_id,sku` with Test Apron's product id → `T-APRON`), and a publication list
   (`product_handle,published` with `test-mug,yes`). Create agents for price, SKU and publication with
   "Without asking, within limits" and an end date. Run them. Expected: each change verified, visible in
   wp-admin, one entry each in the agent's work log.
8. **Stale protection.** Create a review-mode change, then change the same field by hand in wp-admin, then
   approve in Deploi. Expected: **stale**, nothing written.
9. **Webhooks.** Edit Test Apron's stock in wp-admin to 0. Within a minute: a targeted rescan in the scan
   list (trigger "webhook"); WooCommerce → Status → Scheduled Actions shows the delivery completed (HTTP
   200). Place a test order: an `order.created` delivery triggers a rescan of the ordered products.
10. **Disconnect.** Disconnect on the page. Expected: the three webhooks are gone from wp-admin; the
    connection shows Disconnected; then delete the "Deploi" key in wp-admin.
11. Record the results (store URL, WooCommerce/WordPress versions, hosting, any step that differed) in
    `docs/` and update `docs/capability-matrix.md` from "live verification blocked" to "live-verified".

## Things to watch on real hosts (unverified until the live test)

- Hosts that strip the `Authorization` header: Deploi detects "consumer key is missing" and falls back to
  query-string credentials over https (recorded as `auth_mode = query`).
- Security plugins or WAFs that block `PUT` or `/wp-json/`: the write fails with a definite error and the
  execution is marked failed; nothing is retried blindly.
- Stock-altering plugins (multi-inventory) can make REST report values that differ from stored meta;
  verification reads would then fail and be reported.
- The `product.updated` payload for a variation is assumed to carry `parent_id`; if a store sends the
  variation without it, the rescan reads the id as a product and finds nothing (the next full scan corrects it).
- Settings endpoints under `/settings/products/...` are assumed readable; if not, the store-wide
  manage-stock and low-stock values are treated as unknown (checks make no store-wide assumption).

## Code map

| | |
|---|---|
| `lib/connectors/woocommerce/client.ts` | REST client: Basic auth, pagination (`X-WP-TotalPages`), bounded read retries, error classes |
| `lib/connectors/woocommerce/http.ts` | outbound transport: approved host only, public addresses only (pinned), no redirects, timeouts |
| `lib/connectors/woocommerce/connector.ts` | `Connector` implementation (reads, lookups, one-field writes, `allowedFields`) |
| `lib/connectors/woocommerce/checks.ts`, `listing-checks.ts` | backorders, oversold, low stock; publication, price, SKU |
| `lib/connectors/woocommerce/auth.ts`, `connect.ts` | key approval flow, manual keys, connect, disconnect |
| `lib/connectors/woocommerce/webhooks.ts` | registration, signature verification, de-duplication, targeted rescans |
| `lib/connectors/woocommerce/synthetic.ts`, `demo-store.ts` | synthetic store and fake HTTP layer for tests and demos |
| `app/api/woocommerce/*`, `app/store/connect/woocommerce/` | routes and the connect page |
| `tests/woocommerce/` | client, connector, agents end to end, connection flow, webhooks |
