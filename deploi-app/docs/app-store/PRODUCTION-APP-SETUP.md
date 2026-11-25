# Production app setup (about 30 minutes, dashboards only, phone-friendly)

Dev app **Deploi (dev)** stays as it is. This creates the app you submit: **Deploi**. Do the steps in order. Never paste a secret into chat.

## 1. Create the app (Dev Dashboard, org "deploi ai")
1. dev.shopify.com → Apps → **Create app**.
2. Name: `Deploi` (exact). Create.
3. Copy the **Client ID** (shown on the app's home/Settings). The Client ID is public, you may message it to me.
   I set everything else (App URL, redirect URL, webhooks, scopes) with the CLI, so you do not type URLs or scopes. I use exactly:
   - App URL `https://app.getdeploi.com/shopify`, embedded
   - Redirect `https://app.getdeploi.com/api/shopify/auth/callback`
   - Webhooks (API 2026-10) to `https://app.getdeploi.com/api/shopify/webhooks`: app/uninstalled, app/scopes_update, products/create, products/update, products/delete, inventory_levels/update, inventory_items/update, discounts/create, discounts/update, plus customers/data_request, customers/redact, shop/redact
   - Scopes `read_products,write_products,read_inventory,read_locations,read_discounts`; optional `read_publications,write_publications`
   - Same as dev except the host.

## 2. Service account for me (App development, this app only)
1. Same place you made `claude-code-deploi` (dev dashboard → organization settings → service accounts).
2. Create `claude-code-deploi-prod`, permission **App development**, app **Deploi** only, expiry Dec 9 or later.
3. Copy its token. In the Claude cloud environment menu (title bar) → Edit → add environment variable **`SHOPIFY_SERVICE_ACCOUNT_TOKEN_PROD`** → Save.
   (The existing `SHOPIFY_SERVICE_ACCOUNT_TOKEN` stays for the dev app. Environment variables reach a **new session**, so start a new session and say "production token added".)

## 3. Client secret into Vercel (never chat)
1. Dev Dashboard → Deploi → Settings → Client credentials → copy **Client secret**.
2. Vercel → deploi-app → Settings → Environment Variables → add `SHOPIFY_API_SECRET`, **Production only**, Sensitive.

## 4. Production variables (Vercel → deploi-app → Environment Variables, **Production** only, Sensitive where it is a key)
Already there (do not touch): DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_SECRET, CRON_SECRET, STAFF_EMAILS, NEXT_PUBLIC_APP_URL.

| Name | Value | Note |
|---|---|---|
| `SHOPIFY_API_KEY` | Deploi Client ID | |
| `SHOPIFY_API_SECRET` | Deploi client secret | step 3 |
| `SHOPIFY_APP_URL` | `https://app.getdeploi.com` | |
| `SHOPIFY_API_VERSION` | `2026-10` | |
| `SHOPIFY_APP_HANDLE` | `deploi` | |
| `CREDENTIALS_ENCRYPTION_KEY` | your generated key | **Not in Production today** (I checked the list on 2026-11-10 and it is missing: re-add it) |
| `CREDENTIALS_KEY_ID` | `prod-k1` | missing today |
| `STORE_ACCESS_MODE` | `open` | **missing, found by the code audit.** Without it reviewers see the beta card and cannot make changes |
| `EMAIL_LIVE_SENDS` | `off` | stays off through review |
| `AGENT_MAIL_DOMAIN` | `agents.getdeploi.com` | |
| `RESEND_API_KEY` | Resend key, send permission | optional until live sends; the app reports "mock" without it |
| `BILLING_REQUIRED` | `false` | Free listing |

Do **not** set on Production: `AUTH_MODE`, `ALLOW_DEV_LOGIN`, `DEMO_CONTROLS`, `DEVSTORE_ADMIN_TOKEN`, `LIVE_WRITES` (the build refuses dev auth in Production).

## 5. IP allowlist (on **Deploi**, same as dev)
Deploi → Settings → IP allowlist → Manage → **ASN** → add `16509` and `14618`, country **United States** → Save → **Run test**. Leave Enforcement **off** until after the production smoke test; turn it on before Nov 20.

## 6. Partner settings (production app only, never on Deploi (dev))
1. Distribution → **Public distribution (Shopify App Store)** → Confirm (permanent).
2. API access → Protected customer data → **request nothing**.
3. Pricing → **Free**.

## 7. Tell me
Message: **"production app ready, client id <id>"** (and "production token added" in a new session). I link, deploy the config (version name + ID), and report.
