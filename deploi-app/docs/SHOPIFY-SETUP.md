# Shopify app: setup, permissions, billing and submission

Sources: `docs/platform-research/shopify.md` (official Shopify documentation, Admin API 2026-10).
Marketplace approval is a separate step from implementation and is not done.

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

### Agent platform walkthrough (templates, tiers, tasks, work log, weekly summary)

Set `AGENT_MAIL_DOMAIN=agents.getdeploi.test` in `.env.local` so templates can give each agent an address; with `EMAIL_LIVE_SENDS=off` nothing is ever emailed.

1. **Agents** shows three templates (Inventory Watcher, Supplier Chaser, Store Health Checker), each at **drafts only** for Shopify and email, and the **Weekly summary** for this week with time saved labelled **Estimate**.
2. **Use this template** → add your email (or the supplier's) → **Review authorization**: the agent's own address, what it may do, its limits and what it never does → **Grant**.
3. On the agent: **Run now** fills **Drafted changes (not made)**; there is no Approve button, because a drafts-only agent cannot make changes.
4. **Tasks**: "Check overselling on all products now" runs and ends *Waiting on you* (drafts to read). "Fix prices automatically" is *Needs your approval* (outside the rules). "make it better" is *Refused* (nothing runs).
5. **Edit** → "After my approval" → Save: a new version waits for your grant, listing what it adds; the drafts-only version keeps running until you grant it. Granting re-queues tasks that the wider rules now cover.
6. **Work log**: every action with what, when, why and *Allowed by* (authorization version and tier, your approval, or "none").
7. **Pause**, **Revoke** and **Delete** stop everything at once, including queued writes, queued email and queued tasks; deleting also closes the agent's address.

New agents and new email permissions always start at drafts only. Acting without asking needs an end date at most one year away, and widening anything needs a new grant.

## 2. Development store (live verification, not yet done)

1. Partner account, then a development store: `shopify store create dev --name "<name>" --plan basic --demo-data`
   or Dev Dashboard → Stores → Create store → Dev. Dev stores cannot take real payments.
2. Create the app in the Dev Dashboard; copy `shopify.app.toml.example` to `shopify.app.toml` and fill
   `client_id` and `handle`. Deploy configuration with `shopify app deploy`.
3. Environment for the app (names only; values come from the Dev Dashboard and a key generator):
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_API_VERSION=2026-10`, `SHOPIFY_APP_URL`
   - `CREDENTIALS_ENCRYPTION_KEY` (base64 of 32 random bytes), `CREDENTIALS_KEY_ID`
   - `LIVE_WRITE_STORES=<dev-store>.myshopify.com` so corrections may write to that store only
   - keep `BILLING_REQUIRED` unset during early access
4. Apply migrations `20261028000028`, `20261028000029` and `20261028000030` to the target database. Set
   `CRON_SECRET` so `/api/cron/agents` (hourly, see `vercel.json`) runs scheduled agents and refuses anyone else.
5. Install from the Shopify admin (managed installation). The embedded app loads `/shopify`, calls
   `/api/shopify/session` with the App Bridge id token, and the server exchanges it for an expiring offline
   token (stored encrypted).
6. Test webhooks with `shopify app webhook trigger --topic=<topic> --address=https://<app>/api/shopify/webhooks --api-version=2026-10`.
7. Confirm the open items in `docs/shopify-workflow.md` ("What is not verified live").

## 3. Permissions

Installed with the app (`[access_scopes].scopes`, `config.ts#REQUIRED_SCOPES`): **`read_products, read_inventory,
read_locations`**, read only. That is everything the three starter templates need at "drafts only". No customer or
order scopes, which keeps the app at protected customer data Level 0 (no access request needed).

Optional, declared in `optional_scopes` and asked for at runtime (`config.ts#OPTIONAL_SCOPES`): **`write_products,
read_publications, write_publications`**. The embedded app asks Shopify for the write scope an agent needs
(App Bridge `shopify.scopes.request`) only when a merchant widens that agent past drafts only; Shopify shows its
own grant screen; the server re-reads `currentAppInstallation.accessScopes` (`POST /api/store/scopes/sync`) and
also receives `app/scopes_update`. A store that only ever drafts never grants a write scope.

| Scope | When | Used for |
|---|---|---|
| `read_products`, `read_inventory`, `read_locations` | install | variants, prices, SKUs, barcodes, inventory levels, locations; Markets price lists (fixed-price preflight) |
| `write_products` | first agent widened past drafts only with an overselling, price or SKU correction | `productVariantsBulkUpdate`: inventory policy, price, compare-at price, SKU (one field per call) |
| `read_publications` | first publication correction | which sales channels a product is on; the channel list for agent setup. Publication fields are left out of the scan query until it is granted. |
| `write_publications` | first publication correction widened past drafts only | `publishablePublish` / `publishableUnpublish` on the one channel the agent is authorized for |

Every execution re-checks the granted list and ends **blocked: missing permission: <scope>** rather than
writing. Writes to any real store are refused unless that store is listed in `LIVE_WRITE_STORES` (or
`LIVE_WRITES=all` is set deliberately for production). Each agent's writable fields are enforced again inside the
connector. Possibly needed, to confirm on a development store: `write_inventory` if `productVariantsBulkUpdate`
refuses `inventoryItem.sku` without it.

## 4. Billing

App Store apps must bill through Shopify. Shopify App Pricing (formerly Managed Pricing) is the default for
new public apps: plans are set in the Partner Dashboard, Shopify hosts the plan page
(`lib/connectors/shopify/billing.ts#pricingPlansUrl`), and status is read from the Partner API
(`activeSubscription`); App Pricing sends no subscription webhooks. **Blocked:** no plans or prices are
decided, and Partner API credentials (`SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`,
`SHOPIFY_PARTNER_APP_ID`) do not exist. Merchants run under an `early_access` record until then; the
correction gate can require an active subscription with `BILLING_REQUIRED=true`.

## 5. App Store submission checklist

Code (implemented): session-token auth with no third-party cookies or local storage in the embedded app;
App Bridge script; GraphQL only; per-shop `frame-ancestors` CSP (never a wildcard) and `frame-ancestors
'none'` elsewhere; compliance webhooks with HMAC verification and 401 on a bad signature; uninstall handling;
least-privilege scopes; valid TLS on the hosting domain.

Still needed (external): Shopify billing plans (above); a unique app name and listing without statistics,
claims or testimonials; app icon 1200 x 1200; a privacy policy URL (draft exists on the website, pending
legal review); an emergency developer contact (email and phone); a demo screencast in English; working test
credentials for reviewers; a development-store run of the full flow; Shopify's review (timeline not
published). "Built for Shopify" is optional and needs install, review and performance thresholds after launch.
Install must start from Shopify surfaces: the `/api/shopify/auth/start` code-grant route is a fallback for
development and is not linked from the product.
