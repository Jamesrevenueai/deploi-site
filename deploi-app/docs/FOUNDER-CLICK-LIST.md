# Founder click list (one ordered list, 2026-11-10)

Do these in order. **Bold** = message me when done. Nothing goes live until you write "GO LIVE".
Dev app = **Deploi (dev)** (testing only, never public). Production app = **Deploi** (the one submitted).

## Phase 1: open the dev domain safely
1. Supabase → **deploi-preview** (`bhddgjcefwasdyrrfptc`) → Project Settings → Database → **Reset database password**. Copy the new
   connection string (Connection pooling, Transaction mode, port 6543).
2. Vercel → deploi-app → Settings → Environment Variables → `DATABASE_URL` for branch `claude/deploi-platform-launch` → Edit →
   paste the new string → Save (Sensitive). Old preview builds lose the database.
3. Neon → delete the scratch project used by branch `jolly-ptolemy`.
4. Vercel → deploi-app → Environment Variables → delete `AUTH_MODE`, `ALLOW_DEV_LOGIN`, `DEVSTORE_ADMIN_TOKEN`, and the variable
   whose **name** starts with `ec6e664e`.
5. **Message me "steps 1–4 done".** I switch off Vercel Authentication on deploi-app, redeploy and send curl + screenshots.

## Phase 2: database checks
6. Supabase SQL editor: paste `deploi-app/docs/preview/VERIFY-READONLY-2026-11-09.sql` PART 1 in **deploi-prod**, PART 2 in
   **deploi-preview**. **Send me the rows** (I answer PASS/FAIL per check). If PART 1 lacks `ojae@getdeploi.com`, run
   `deploi-app/docs/hotfix/STAFF-ADD-OJAE.sql` in deploi-prod.

## Phase 3: the dev app and its install
7. On your Mac (Terminal), once:
   ```
   npm install -g @shopify/cli@latest
   git clone https://github.com/Jamesrevenueai/deploi-site.git && cd deploi-site && git checkout claude/deploi-platform-launch && cd deploi-app
   ```
8. Push the **dev** app config:
   ```
   shopify app config link --client-id ec6e664e411d86611e86cde230e6202e --file-name shopify.app.deploi-dev.toml
   sed 's/<SHOPIFY_API_KEY of Deploi (dev)>/ec6e664e411d86611e86cde230e6202e/' shopify.app.deploi-dev.toml.example > shopify.app.deploi-dev.toml
   shopify app deploy --config deploi-dev        # answer: Yes, release
   ```
9. dev.shopify.com → Deploi (dev) → **Install app** → `james-jwtftl1e`. **Message me "installed".**
   I run the in-store test (every agent, uninstall/reinstall, the 3 privacy webhooks, all tests, 1600×900 screenshots) → STOP #2.

## Phase 4: email (support@ mailbox + the app's own sending)
The app **sends** email from `@getdeploi.com`: invites, owner notifications and weekly summaries from `support@getdeploi.com`
(`lib/email/system.ts`), and agent emails from `<agent>@agents.getdeploi.com` (`lib/email/adapters/deploi.ts`), both through
**Resend**. Resend uses its own Return-Path (`send.…`), so the root SPF does not block it; DKIM signs it.
10. **Zoho Mail (Forever Free)**: sign up, add `getdeploi.com`, add the verification TXT Zoho shows in Squarespace, create the user
    `support@getdeploi.com`.
11. Squarespace → getdeploi.com → DNS. **Delete**: TXT `@` `v=spf1 -all` and TXT `_dmarc` (the Email Security preset). **Add**:

    | Host | Type | Value | For |
    |---|---|---|---|
    | `@` | MX | `mx.zoho.com` priority 10 | Zoho (receive support@) |
    | `@` | MX | `mx2.zoho.com` priority 20 | Zoho |
    | `@` | MX | `mx3.zoho.com` priority 50 | Zoho |
    | `@` | TXT | `v=spf1 include:zohomail.com -all` | SPF (Zoho sends as support@) |
    | Zoho's selector, e.g. `zmail._domainkey` | TXT | the key from Zoho → Email Authentication → DKIM | DKIM for Zoho |
    | `_dmarc` | TXT | `v=DMARC1; p=quarantine; rua=mailto:support@getdeploi.com; adkim=s; aspf=r` | DMARC |
12. Resend → Domains → **Add `getdeploi.com`** (system mail). Add exactly what Resend shows, normally:
    `resend._domainkey` TXT (DKIM key), `send` MX `feedback-smtp.us-east-1.amazonses.com` priority 10, `send` TXT
    `v=spf1 include:amazonses.com ~all`. Wait for **Verified**.
13. Resend → Domains → **Add `agents.getdeploi.com`**, turn on **Receiving**. Add exactly what Resend shows, normally:
    `resend._domainkey.agents` TXT, `send.agents` MX + TXT, `agents` MX (Resend's inbound host), and
    `_dmarc.agents` TXT `v=DMARC1; p=none; rua=mailto:support@getdeploi.com; adkim=s; aspf=r`. Wait for **Verified**.
14. Send a test mail from an outside address to `support@getdeploi.com` and reply from Zoho. **Message me "mail done"**: I dig
    MX/SPF/DKIM/DMARC (values verbatim) and confirm the round trip from the headers you forward me.

## Phase 5: the production app "Deploi" (the one you submit)
15. dev.shopify.com (org "deploi ai") → Apps → **Create app** → name **Deploi** → create. Copy its **Client ID**.
16. In Terminal (in `deploi-app`):
    ```
    shopify app config link --client-id <Deploi client ID> --file-name shopify.app.deploi.toml
    sed 's/<SHOPIFY_API_KEY>/<Deploi client ID>/' shopify.app.toml.example > shopify.app.deploi.toml
    shopify app deploy --config deploi             # answer: Yes, release
    ```
    It sets: App URL `https://app.getdeploi.com/shopify` (embedded); redirect `https://app.getdeploi.com/api/shopify/auth/callback`;
    webhooks (API 2026-10) to `https://app.getdeploi.com/api/shopify/webhooks`: app/uninstalled, app/scopes_update,
    products/create, products/update, products/delete, inventory_levels/update, inventory_items/update, discounts/create,
    discounts/update + compliance customers/data_request, customers/redact, shop/redact; scopes
    `read_products,write_products,read_inventory,read_locations,read_discounts`; optional `read_publications,write_publications`.
    Identical to the dev app except the host. Check: Deploi → Versions shows the new version Active with those scopes.
17. Deploi → Settings → Client credentials: copy the **Client secret** straight into Vercel (next step). Never into chat.
18. Vercel → deploi-app → Environment Variables → **Production** only, Sensitive on:
    `SHOPIFY_API_KEY` = Deploi client ID · `SHOPIFY_API_SECRET` = Deploi client secret · `SHOPIFY_APP_URL` = `https://app.getdeploi.com` ·
    `SHOPIFY_API_VERSION` = `2026-10` · `SHOPIFY_APP_HANDLE` = `deploi` · `CREDENTIALS_ENCRYPTION_KEY` = output of `openssl rand -base64 32`
    (run in Terminal) · `CREDENTIALS_KEY_ID` = `prod-k1` · `AGENT_MAIL_DOMAIN` = `agents.getdeploi.com` · `RESEND_API_KEY` = a Resend key
    with send permission · `EMAIL_LIVE_SENDS` = `off` (I change it after the smoke test, with you).
19. **IP allowlist (due Nov 20)**, on **Deploi** (production) and on Deploi (dev): app → Settings → IP allowlist → Manage → **ASN** →
    add `16509` and `14618`, country **United States** → Save → **Run test** → turn on **Enforcement** only when the test is clean
    (for Deploi, after the production smoke test has made some traffic).
20. **Only on Deploi (production), never on Deploi (dev):**
    - Distribution → **Public distribution (Shopify App Store)** → Confirm (permanent).
    - API access → Protected customer data → **request nothing** (the app asks for no customer or order scopes).
    - Pricing → **Free**.
21. **Message me "production app ready".**

## Phase 6: release and submission (after STOP #2 and your written "GO LIVE")
22. I merge PRs #16, #17, #18, apply migrations 058–064 to deploi-prod, deploy app.getdeploi.com (previous deployment kept for rollback).
23. You install **Deploi** (production) on `james-jwtftl1e` (dev.shopify.com → Deploi → Install app); I run 3 agents and confirm
    webhooks reach production; any failure → immediate rollback.
24. I send the submission package (listing, screenshots, reviewer steps, checklist) → STOP #3 → you click **Submit**.
25. After the old Deploi (dev) client secret is no longer used: dev.shopify.com → Deploi (dev) → revoke the **old** secret.
