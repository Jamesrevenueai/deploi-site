# Shopify production app "Deploi": exact settings

Generated 2026-11-22 from the code on branch `claude/tender-pascal-0fax6x` (not from older docs). Sources:
`deploi-app/shopify.app.toml.example`, `deploi-app/lib/connectors/shopify/config.ts` (`REQUIRED_SCOPES`,
`EVENT_SCOPES`, `OPTIONAL_SCOPES`, `SUBSCRIBED_EVENT_TOPICS`), `deploi-app/app/api/shopify/*`.
**Deploi (dev)** stays the testing app and is never made public. Everything below is for the new app **Deploi**.

## 1. App identity

| Setting | Value |
|---|---|
| App name | `Deploi` |
| Handle (`SHOPIFY_APP_HANDLE`) | `deploi` |
| App URL (embedded admin) | `https://app.getdeploi.com/shopify` |
| Embedded in Shopify admin | Yes |
| Automatically update URLs on `dev` | No |
| POS | Not embedded |
| Distribution | Public distribution (Shopify App Store). Permanent, so set it only on **Deploi** |
| Pricing | **Free** (no plans; `BILLING_REQUIRED=false`) |
| Protected customer data | **Request nothing** in this submission (no order, customer, fulfillment or return scopes) |

## 2. Redirect URLs (allowed redirection URLs)

```
https://app.getdeploi.com/api/shopify/auth/callback
```

Managed installation (Shopify's default) is used, and the app exchanges the session token for an offline token.
This URL is only the non-embedded fallback (authorization-code grant). `use_legacy_install_flow` is not set.

## 3. Access scopes

| Kind | Scopes | Why (as code) |
|---|---|---|
| Required at install | `read_products,write_products,read_inventory,read_locations,read_discounts` | `REQUIRED_SCOPES` + `EVENT_SCOPES` (`read_discounts` for discount events) |
| Optional, asked at runtime | `read_publications,write_publications` | `OPTIONAL_SCOPES`, only when a merchant turns on publication correction |

There are no customer, order, fulfillment, return, payout, inventory-quantity or discount **write** scopes.

## 4. Webhook subscriptions (API version `2026-10`, all to `https://app.getdeploi.com/api/shopify/webhooks`)

| Topics | Purpose |
|---|---|
| `app/uninstalled` | marks the connection uninstalled, deletes the stored token, pauses every agent |
| `app/scopes_update` | re-reads granted scopes |
| `products/create`, `products/update`, `products/delete`, `inventory_levels/update`, `inventory_items/update` | debounced targeted rescans + agent events |
| `discounts/create`, `discounts/update` | agent events |
| Compliance: `customers/data_request`, `customers/redact`, `shop/redact` | mandatory privacy topics (export, anonymise, erase) |

Every delivery is HMAC-verified with `SHOPIFY_API_SECRET`. An unsigned or wrongly signed delivery gets **401**
(tests: `tests/shopify/webhooks.test.ts`, `tests/merchant/shopify-routes.test.ts`).

## 5. `shopify.app.deploi.toml`

Copy `deploi-app/shopify.app.toml.example` to `deploi-app/shopify.app.deploi.toml` and replace `client_id` with
the Deploi Client ID (the Client ID is public). Release it with `shopify app deploy --config deploi`. A cloud
session can do this once `SHOPIFY_SERVICE_ACCOUNT_TOKEN_PROD` exists (see FOUNDER_ACTIONS.md).

## 6. Environment variables deploi-app needs in **Production** (names only)

**Already set on Production (checked 2026-11-22):** `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `APP_SECRET`, `CRON_SECRET`, `STAFF_EMAILS`, `NEXT_PUBLIC_APP_URL`, `PUBLIC_API_ALLOWED_ORIGINS`,
`CREDENTIALS_KEY_ID` (`prod-k1`), `STORE_ACCESS_MODE` (`review`).

**Must be added before the production app works:**

| Name | Value | Sensitive |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes, base64, fresh, production only | yes |
| `SHOPIFY_API_KEY` | Deploi Client ID | no |
| `SHOPIFY_API_SECRET` | Deploi client secret | yes |
| `SHOPIFY_APP_URL` | `https://app.getdeploi.com` | no |
| `SHOPIFY_API_VERSION` | `2026-10` | no |
| `SHOPIFY_APP_HANDLE` | `deploi` | no |
| `EMAIL_LIVE_SENDS` | `off` (through review) | no |
| `AGENT_MAIL_DOMAIN` | `agents.getdeploi.com` | no |
| `BILLING_REQUIRED` | `false` | no |

**Add after Resend verifies getdeploi.com:** `RESEND_API_KEY` (sensitive), `AGENT_MAIL_WEBHOOK_SECRET` (sensitive).

**Never on Production:** `AUTH_MODE`, `ALLOW_DEV_LOGIN`, `DEMO_CONTROLS`, `DEVSTORE_ADMIN_TOKEN`, `LIVE_WRITES`.
None of these is on Production today (checked 2026-11-22). The build also refuses dev auth on Production.

**Office / Track B (leave unset or `off` on Production for this submission):** `OFFICE_PHONE_AGENTS`, `OFFICE_SIGNUP`,
`NOTIFY_SMS_PROVIDER`, `NOTIFY_LIVE_SENDS`, `NOTIFY_ALLOWED_NUMBERS`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `PHONE_WEBHOOK_SECRET`, `PHONE_WEBHOOK_BASE_URL`. deploi-site: `VITE_OFFICE_SIGNUP`.

**After Shopify approves the listing:** change `STORE_ACCESS_MODE` from `review` to `open` and redeploy.

## 7. IP allowlist (Dev Dashboard → Deploi → Settings → IP allowlist)

Deploi calls Shopify from Vercel serverless functions, which run on AWS in the US (`iad1`).

| Type | Value |
|---|---|
| ASN | `16509` (Amazon.com, Inc.) |
| ASN | `14618` (Amazon.com, Inc., AMAZON-AES) |
| Country | United States |

1. Add all three. Save.
2. Click **Run test**. You should see 0 blocked.
3. Leave **Enforcement** off until the production smoke test passes. Then turn it on and run the test again.

If the screen asks for IP ranges instead of ASNs, use AWS's published ranges for `us-east-1`
(https://ip-ranges.amazonaws.com/ip-ranges.json, service `EC2`). Vercel has no fixed outbound IPs unless
Secure Compute is bought.

## 8. Review-period store access

`STORE_ACCESS_MODE=review`: only Shopify development stores, and stores staff approve on
`https://app.getdeploi.com/staff/store-access`, can be changed by agents. Every store can install and read.
Tests: `tests/merchant/access.test.ts` ("review mode (App Store review)…", "review mode: a reviewer development
store can be changed end to end…"), `tests/merchant/review-mode-agents.test.ts`.
