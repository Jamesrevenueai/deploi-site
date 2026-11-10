# Founder click list: only what is left (2026-11-10, after STOP #1)

All dashboard clicks, no CLI, no Terminal. I run every Shopify CLI step. **Bold** = message me.
Dev app = **Deploi (dev)** (testing only, never public). Production app = **Deploi** (the one submitted).
Never paste a secret into chat: paste it only into the Vercel / Shopify field named in the step.

## 1. Unblock the dev domain (I cannot do these: the values are secret or I have no delete tool)
1. Vercel → deploi-app → Settings → Environment Variables → find **`DATABASE_URL`**, Preview, branch `claude/deploi-platform-launch`
   (created 2026-11-06, still holds the OLD password) → Edit → paste the new pooler string (port 6543) → Save, Sensitive on.
   Why: the app reads only `DATABASE_URL` (`lib/env.ts`). `DATABASE_URL_POOLED` is read nowhere, so the string you put there is unused.
2. Same page: delete **`DATABASE_URL_POOLED`** (Preview, all branches). It is an unused copy of a live credential.
3. Same page: delete **`AUTH_MODE`** and **`ALLOW_DEV_LOGIN`** (Preview, all branches). Both are still listed (values `supabase` / `false`).
4. Same page: delete every variable scoped to branch `claude/jolly-ptolemy-kp7ljd`: `SHOPIFY_API_SECRET` (the old dev secret that was shared
   in chat), `SHOPIFY_API_KEY`, `EMAIL_LIVE_SENDS`, `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID`, `SHOPIFY_APP_URL`, `AGENT_MAIL_DOMAIN`.
5. **Message me "unblocked".** I re-list the variables; if clean I switch off Vercel Authentication on deploi-app, redeploy and send the
   curl, before/after screenshots, the 401 on an unsigned webhook and the database read.

## 2. Install the dev app
6. dev.shopify.com → org "deploi ai" → Deploi (dev) → **Install app** → `james-jwtftl1e`. The version `dev-20261110-0329-707265b` is
   already released and active. Do this only after I say step 5 passed (the install needs the public dev domain and a working database).
7. **Message me "installed".** STOP #2: I run the in-store test and report.

## 3. Production app (needed before your "GO LIVE")
8. dev.shopify.com → Apps → **Create app** → name **Deploi** → create. **Send me the Client ID** (public, not a secret).
9. dev.shopify.com → Deploi → Settings → Client credentials: copy the **Client secret** straight into Vercel (step 11).
10. Service account for Deploi: dev.shopify.com → Settings → Service accounts → create `claude-code-deploi-prod`, access **App development**
    for **Deploi** only (not Deploi (dev)). Add the token to my cloud environment as **`SHOPIFY_SERVICE_ACCOUNT_TOKEN_PROD`** (a second
    name, so the dev token keeps working). Do not set any other Shopify token variable.
11. Vercel → deploi-app → Environment Variables → **Production only**, Sensitive on for the secrets:
    - `SHOPIFY_API_KEY` = Deploi client ID · `SHOPIFY_API_SECRET` = Deploi client secret · `SHOPIFY_APP_URL` = `https://app.getdeploi.com`
    - `SHOPIFY_API_VERSION` = `2026-10` · `SHOPIFY_APP_HANDLE` = `deploi`
    - `CREDENTIALS_ENCRYPTION_KEY` = your saved key. **It is not in Vercel Production today** (only on three preview branches). Add it.
    - `CREDENTIALS_KEY_ID` = `prod-k1` · `EMAIL_LIVE_SENDS` = `off`
    - Later, before emails go on: `RESEND_API_KEY`, `AGENT_MAIL_DOMAIN` = `agents.getdeploi.com` (see step 16).
12. **Message me "production app ready".** I link and release `shopify.app.deploi.toml` with the CLI and send the version name and ID.

## 4. Settings only on Deploi (production), never on Deploi (dev)
13. Distribution → **Public distribution (Shopify App Store)** → Confirm (permanent). Pricing → **Free**.
14. API access → Protected customer data → **request nothing** (the app asks for no customer or order scopes).
15. IP allowlist (due **Nov 20**): Deploi → Settings → IP allowlist → Manage → ASN `16509` and `14618`, country United States → Save → Run test.
    Turn **Enforcement** on only when the test shows 0 blocked. For Deploi (dev): turn it on after the in-store test passes (I remind you).
    For Deploi (production): after the production smoke test has made traffic.

## 5. Email sending (after GO LIVE, before `EMAIL_LIVE_SENDS` is turned on; receiving support@ already works)
16. Resend → Domains → add `getdeploi.com`, then `agents.getdeploi.com` (turn on Receiving). In Squarespace DNS add **exactly** what Resend shows
    and nothing else: do **not** touch the root `@` MX (Mailgun), root SPF or `_dmarc`. Wait for Verified, then **message me "resend done"**.
    Why this is safe with DMARC `p=reject; adkim=s; aspf=s`: Resend signs with DKIM `d=getdeploi.com` (and `d=agents.getdeploi.com`),
    which aligns strictly, so DMARC passes on DKIM even though SPF alignment (Return-Path `send.…`) does not.
    Until the Resend DKIM record exists, every Resend email from `@getdeploi.com` would be rejected by receivers.

## 6. Last
17. Vercel → deploi-app → Settings → Deployment Protection → Protection Bypass for Automation: **revoke / regenerate** the bypass secret.
    It was embedded in the old dev app URLs in Shopify (now replaced) and was printed in my session output.
18. Only after Deploi (dev) runs on a new secret: dev.shopify.com → Deploi (dev) → Settings → create a new client secret, put it in Vercel
    `SHOPIFY_API_SECRET` (Preview), redeploy, check the preview, then **revoke the old secret**.
19. Submission (after my package, STOP #3): you click **Submit**. If Shopify asks for a full public street address, I stop and tell you first.
