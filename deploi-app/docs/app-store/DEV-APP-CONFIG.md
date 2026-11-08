# Deploi (dev): app configuration for the development-store run (2026-11-08)

App: **Deploi (dev)**, org "deploi ai", client ID `ec6e664e411d86611e86cde230e6202e` (public; the secret is never written here).
Dev store: `james-jwtftl1e.myshopify.com`. Host: `https://dev.getdeploi.com` = the PR #18 preview (branch `claude/deploi-platform-launch`,
database deploi-preview). Production (`app.getdeploi.com`, deploi-prod) is not involved.

## 1. Vercel variables (Preview, branch `claude/deploi-platform-launch`): set 2026-11-08

| Variable | Value | Who |
|---|---|---|
| `SHOPIFY_API_KEY` | `ec6e664e411d86611e86cde230e6202e` | set |
| `SHOPIFY_API_SECRET` | the rotated ("New") client secret, Sensitive | founder (all previews) |
| `SHOPIFY_APP_URL` | `https://dev.getdeploi.com` | set |
| `SHOPIFY_API_VERSION` | `2026-10` | set |
| `NEXT_PUBLIC_APP_URL` | `https://dev.getdeploi.com` | set |
| `ALLOW_DEV_LOGIN` | `false` (overrides the all-previews `true`: no dev sign-in picker on the public domain) | set |
| `AUTH_MODE` | `supabase` (overrides the all-previews `dev`) | set |

Already there: `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID`, `DATABASE_URL` (deploi-preview), `CRON_SECRET`, `APP_SECRET`,
`AI_PROVIDER=off`, `EMAIL_LIVE_SENDS=off`. Leave `BILLING_REQUIRED` and `STORE_ACCESS_MODE` unset (development stores are let in).

A stray Preview variable whose **name** is the client ID (`ec6e664e…`) exists since 2026-10-30; it is unused. Delete it in
Vercel → deploi-app → Settings → Environment Variables when convenient.

## 2. The app version (scopes, URLs, webhooks, compliance topics)

The webhook subscriptions and the three compliance topics are part of the app's configuration file; the Shopify CLI
deploys them all at once, so the CLI is the reliable way. On your Mac, in Terminal:

```bash
# once: Node 20+ and the Shopify CLI
brew install node            # skip if `node -v` prints v20 or later
npm install -g @shopify/cli@latest

# the repository, on the PR #18 branch
git clone https://github.com/Jamesrevenueai/deploi-site.git
cd deploi-site && git checkout claude/deploi-platform-launch && cd deploi-app

# link the Deploi (dev) app (a browser window asks you to log in to the "deploi ai" organization)
shopify app config link --client-id ec6e664e411d86611e86cde230e6202e --file-name shopify.app.deploi-dev.toml

# replace what `link` wrote with the prepared configuration (same client ID)
sed 's/<SHOPIFY_API_KEY of Deploi (dev)>/ec6e664e411d86611e86cde230e6202e/' shopify.app.deploi-dev.toml.example > shopify.app.deploi-dev.toml

# release it as a new version (answer "Yes, release this new version")
shopify app deploy --config deploi-dev
```

Never commit `shopify.app.deploi-dev.toml` (`.gitignore` keeps it out).

What the version contains (from `shopify.app.deploi-dev.toml.example`):
- **App URL:** `https://dev.getdeploi.com/shopify`, embedded in the Shopify admin.
- **Allowed redirection URL:** `https://dev.getdeploi.com/api/shopify/auth/callback`. Install uses Shopify-managed install and token
  exchange (`use_legacy_install_flow = false`), so this URL is a fallback.
- **Scopes:** `read_products,write_products,read_inventory,read_locations,read_discounts`.
- **Optional scopes:** `read_publications`, `write_publications`.
- **Webhooks**, API version `2026-10`, all to `/api/shopify/webhooks`: `app/uninstalled`, `app/scopes_update`, `products/update`,
  `products/delete`, `inventory_levels/update`, `inventory_items/update`, `discounts/create`, `discounts/update`.
- **Compliance topics:** `customers/data_request`, `customers/redact`, `shop/redact`, to the same address.

Check it in the Dev Dashboard → Deploi (dev) → **Versions**: the new version is Active, and it lists those scopes and the
three compliance topics.

**Without the CLI (Dev Dashboard only):** Deploi (dev) → Versions → **Create a version** → set App URL
`https://dev.getdeploi.com/shopify`, tick **Embed app in Shopify admin**, Scopes and Optional scopes as above, untick
**Use legacy install flow**, Redirect URLs as above, Webhooks API version `2026-10` → **Release**. If the form does not
offer the webhook topics or the compliance topics, use the CLI above for those; the App Store review checks the compliance topics.

## 3. Install

Only after `dev.getdeploi.com` answers without the Vercel sign-in (FOUNDER_ACTIONS item P):
Dev Dashboard → Deploi (dev) → **Install app** → `james-jwtftl1e`. The app opens inside the store admin at `/shopify`.
Then tell me; I run `docs/APP-STORE-OPEN-ITEMS.md` §6 and `LISTING.md` §8 there.

## 4. IP allowlist (Shopify: required for public apps by 2026-11-20)

The IP allowlist limits where the app's tokens can call the Admin API; a call from anywhere else gets a 403. Shopify
requires every public app to configure one by **2026-11-20** (2026-11-12 for apps that use bulk operations; Deploi does not).
Dev Dashboard → app → **Settings** → **IP allowlist** → **Manage**.

Deploi calls the Admin API from Vercel Functions (region `iad1`, Washington DC), which have no fixed outbound IP. Two ways:
1. **By network (no cost):** choose ASN and add Amazon's network **AS16509** (and **AS14618**), with country **United States**.
   This allows any AWS address in the US, which is broad but what Shopify offers for serverless hosts.
2. **Fixed IPs:** Vercel's static outbound IP feature for the project, then add those addresses (narrower; a paid Vercel feature).

Whichever you choose, press **Run test** first: it replays the app's recent traffic against the list. Turn **Enforcement**
on only when the test shows no request would have been refused. On the dev app, leave enforcement off until the
dev-store run has produced some traffic to test against. The production app needs the same before 2026-11-20.

Sources: shopify.dev/docs/apps/build/dev-dashboard/ip-allowlist; shopify.dev/changelog/posts/ip-allowlists-are-now-required-for-public-apps.
