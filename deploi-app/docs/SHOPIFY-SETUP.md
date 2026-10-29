# Shopify app: setup, permissions, billing and submission

Sources: `docs/platform-research/shopify.md` and `docs/platform-research/shopify-app-store.md` (official
Shopify documentation, Admin API 2026-10). Submission package: `docs/APP-STORE-SUBMISSION.md`.
Marketplace approval is a separate step from implementation. The app has not been submitted, reviewed
or approved.

## 1. Local synthetic demonstration (no Shopify account needed)

```bash
cd deploi-app
npm install
npm run db:migrate && npm run seed      # local Postgres; seeds two synthetic merchants with synthetic stores
npm run dev                              # http://localhost:3000/login (dev sign-in lists seeded users)
```

Sign in as `owner@northwind-goods.example` and open **Agents**. Four synthetic agents are seeded, each with an
authorization marked as granted by the seeded demo owner:

| Agent | Correction | Mode | What a run shows |
|---|---|---|---|
| Stock Guardian | overselling settings, all products | authorized, every 6 h | 5 changes **Verified**; pre-order, backorder and selling-plan products untouched |
| Price Keeper | price from "Northwind price list" | review, daily | 3 changes **Awaiting approval**; EUR row and duplicate rows **Need a person** |
| Channel Keeper | publication on Online Store from "Online Store product list" | review, manual | walnut board to publish; draft and conflicting rows go to a person; scheduled product left alone |
| SKU Filler | SKU from "Northwind SKU mapping", fill only | authorized, manual | coasters filled and **Verified**; shared barcode, SKU in use and overwrite go to a person |

Approving the pour-over set's price change ends **Blocked**: it has a fixed wholesale price, so changing the base
price would not reach those buyers. **Create agent** walks through plain English, then the structured review, then the
readable authorization, then the grant. The demo store and reference files are invented (see
`lib/connectors/shopify/demo-store.ts`). `owner@harbor-supply.example` sees none of Northwind's data.

## 2. Development store (live verification, not yet done)

1. Partner account, then a development store: `shopify store create dev --name "<name>" --plan basic --demo-data`
   or Dev Dashboard → Stores → Create store → Dev. Dev stores cannot take real payments.
2. Create the app in the Dev Dashboard; copy `shopify.app.toml.example` to `shopify.app.toml` and fill
   `client_id` and `handle`. Deploy configuration with `shopify app deploy`.
3. Environment for the app (names only; values come from the Dev Dashboard and a key generator):
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_API_VERSION=2026-10`, `SHOPIFY_APP_URL`
   - `CREDENTIALS_ENCRYPTION_KEY` (base64 of 32 random bytes), `CREDENTIALS_KEY_ID`
   - `STORE_ACCESS_MODE=beta` (default): development stores are enabled automatically (Shopify's
     `shop.plan.partnerDevelopment`); other stores need an invite or staff approval (`/staff/store-access`).
     Use `open` for the App Store submission and listing (see §5).
   - `LIVE_WRITES=off` pauses writes to every real store (incident switch); leave unset otherwise
   - keep `BILLING_REQUIRED` unset during early access
4. Apply migrations `20261028000028` to `20261029000032` to the target database (`npm run db:migrate:prod`). Set
   `CRON_SECRET` so `/api/cron/agents` (hourly, see `vercel.json`) runs scheduled agents and refuses anyone else.
5. Install from the Shopify admin (managed installation). The embedded app loads `/shopify`, calls
   `/api/shopify/session` with the App Bridge id token, and the server exchanges it for an expiring offline
   token (stored encrypted).
6. Test webhooks with `shopify app webhook trigger --topic=<topic> --address=https://<app>/api/shopify/webhooks --api-version=2026-10`.
7. Confirm the open items in `docs/shopify-workflow.md` ("What is not verified live").

## 3. Permissions

`read_products, write_products, read_inventory, read_locations, read_publications, write_publications`. No customer
or order scopes, which keeps the app at protected customer data Level 0 (no access request needed).

| Scope | Used for |
|---|---|
| `read_products`, `read_inventory`, `read_locations` | variants, prices, SKUs, barcodes, inventory levels; Markets price lists (fixed-price preflight) |
| `write_products` | inventory policy, price, compare-at price and SKU (`productVariantsBulkUpdate`, one field per call) |
| `read_publications` | which sales channels a product is published on; the channel list for agent setup |
| `write_publications` | `publishablePublish` / `publishableUnpublish` on the one channel an agent is authorized for |

Possibly needed, to confirm on a development store: `write_inventory` if `productVariantsBulkUpdate` refuses
`inventoryItem.sku` without it. Writes to a real store need store access (`lib/engine/access.ts`): open mode,
a development store, a redeemed beta invite or staff approval; a staff denial or `LIVE_WRITES=off` blocks
them. Each agent's writable fields are enforced again inside the connector.

## 4. Billing

App Store apps must bill through Shopify. Shopify App Pricing (formerly Managed Pricing) is the default for
new public apps: plans are set in the Partner Dashboard, Shopify hosts the plan page
(`lib/connectors/shopify/billing.ts#pricingPlansUrl`), and status is read from the Partner API
(`activeSubscription`, `lib/connectors/shopify/billing.ts#syncSubscription`, re-read on app open, after the
plan page redirects back with `plan_handle`, and at most every 5 minutes); App Pricing sends no subscription
webhooks. With `BILLING_REQUIRED=true` the Overview shows **View plans in Shopify** (opened at the top level)
and changes are blocked until a plan is active. **Blocked:** no plans or prices are decided, and Partner
API credentials (`SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ID` (the number in the Partner Dashboard
URL), `SHOPIFY_PARTNER_APP_ID`) do not exist. Set the plan's welcome link to `/shopify` so the plan is re-read
on return. Beta merchants can get private plans limited to their stores.

## 5. App Store submission

See `docs/APP-STORE-SUBMISSION.md` for the listing draft, reviewer instructions, screencast script, the
submission checklist and every remaining blocker.
