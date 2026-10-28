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

Sign in as `owner@northwind-goods.example`, open **Overview**, press **Run scan**, open a high-priority
issue, review the evidence and press **Approve this change**: the outcome shows **Verified** after a fresh
read. The **Store** page has demo controls (synthetic stores only) to make an outside change (shows
**Stale**) or inject a platform fault (shows **Failed**, then **Retry**). `owner@harbor-supply.example`
shows the first-run setup question and sees none of Northwind's data.

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
4. Apply migrations `20261028000028` and `20261028000029` to the target database.
5. Install from the Shopify admin (managed installation). The embedded app loads `/shopify`, calls
   `/api/shopify/session` with the App Bridge id token, and the server exchanges it for an expiring offline
   token (stored encrypted).
6. Test webhooks with `shopify app webhook trigger --topic=<topic> --address=https://<app>/api/shopify/webhooks --api-version=2026-10`.
7. Confirm the open items in `docs/shopify-workflow.md` ("What is not verified live").

## 3. Permissions

`read_products, write_products, read_inventory, read_locations`. No customer or order scopes, which keeps
the app at protected customer data Level 0 (no access request needed). `write_products` is needed only for
the inventory-policy correction. Writes to any real store are refused unless that store is listed in
`LIVE_WRITE_STORES` (or `LIVE_WRITES=all` is set deliberately for production).

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
