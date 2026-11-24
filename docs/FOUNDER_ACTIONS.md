# FOUNDER_ACTIONS: your clicks, in order (updated 2026-11-24)

Only things that need your login, a secret, money or a legal decision. Never paste a secret into chat: paste it only
into the Vercel, Shopify, Twilio or Resend field the step names. Each step ends with **Done looks like**.

Production did **not** ship on 2026-11-22: the gate failed (see "Why production did not ship" at the bottom).
Steps 1 to 4 open the gate. Message the cloud session **"gate ready"** after step 4 and it runs the ship.

---

## Phase A results (2026-11-24): what is on you now, in order

1. **IP allowlist on Deploi (dev): §8.** It can only be set in the Dev Dashboard (no CLI or API). The dev app is
   installed only on your own dev store, so Shopify does not require it there, but set it anyway. The production app
   needs it before it can be listed.
2. **Create the production app "Deploi": §6.** The CLI service account was refused ("User does not have access to
   create_app"). Either create it in the Dev Dashboard, or give the service account permission to create apps
   (dev.shopify.com → Settings → Service accounts → the account → App development: create apps), then tell the
   session. `deploi-app/shopify.app.production.toml` is ready: the session links it to the new Client ID and runs
   `shopify app deploy --config production`.
3. **Restore the preview database.** The dev-store harness on dev.getdeploi.com cannot reach its database:
   "tenant/user postgres.bhddgjcefwasdyrrfptc not found". supabase.com → project **deploi-preview**
   (bhddgjcefwasdyrrfptc): if it says **Paused**, click **Restore**. Then Settings → Database → Connection string →
   **Transaction pooler**, and check it matches Vercel → deploi-app → `DATABASE_URL_POOLED` (Preview). Copy it in again
   if the host changed.
4. **Supabase token for this session.** The token you saved is in the cloud environment **"deploi"**. This session
   runs in the environment **"claimyours-deploy"**, which holds the Shopify, Vercel and dev-store secrets, and it cannot
   be moved. I asked for the token through the secure form and it was saved here, but api.supabase.com still answers
   "Invalid access token". Check that the token was created at supabase.com/dashboard/account/tokens (an account
   access token starting `sbp_`, not a project API key). Then re-save it on this environment: Settings → Environments →
   claimyours-deploy → Network secrets → api.supabase.com, header `Authorization`, value `Bearer <token>`.
5. **Rotate the two exposed secrets: §2.** They are the **Vercel protection-bypass secret** and the
   **Deploi (dev) client secret**. The Supabase token you rotated on 2026-11-23 was a separate leak, so both of these
   are still open.
6. **Production keys: `docs/ENV_PREFLIGHT.md`**, top table (Shopify keys after step 2; Resend keys after §3).
7. **Stripe test keys** (Office billing): `STRIPE_SECRET_KEY` (sk_test_) and `STRIPE_WEBHOOK_SECRET` on Vercel Preview,
   plus `BILLING_MODE=test`. Until then Office billing is BLOCKED-ON-FOUNDER.
8. **QuickBooks and Outlook** (Office connections): QuickBooks needs a sandbox app at developer.intuit.com
   (`QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT=sandbox`). Outlook needs an Azure app
   registration (`MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT=common`). None is
   set anywhere, so neither can connect yet.
9. After 3: tell the session **"preview db back"**. It then runs the 12 agents on james-jwtftl1e and retakes the
   listing screenshots. Keep `DEVSTORE_ADMIN_TOKEN` until that passes.

---

## 1. Add the production encryption key (2 min). Gate (a)
1. On your computer: `openssl rand -base64 32` (or your password manager: 32 random bytes, base64). Do not reuse a preview key.
2. vercel.com → team **JamesAi** → **deploi-app** → Settings → Environment Variables → **Add**:
   key `CREDENTIALS_ENCRYPTION_KEY`, the value, **Production** only, **Sensitive** on → Save.
3. Save a copy in your password manager as "Deploi prod-k1".
- **Done looks like:** the list shows `CREDENTIALS_ENCRYPTION_KEY` with a lock, Production, next to `CREDENTIALS_KEY_ID`.

## 2. Rotate the two exposed secrets, then write "rotated" here (5 min). Gate (b)
**2a. The Vercel protection bypass secret**
- Where: deploi-app → Settings → Deployment Protection → Protection Bypass for Automation.
- Click **Regenerate**.

**2b. The Deploi (dev) client secret**
1. dev.shopify.com → Deploi (dev) → Settings → Client credentials → **Create new secret**.
2. Paste it into Vercel → deploi-app → `SHOPIFY_API_SECRET` (Preview) → Save.
3. Redeploy the newest Preview.
4. Back in Shopify, **Revoke** the old secret.

**2c. Record it.** Add one line under "Your confirmations" at the bottom of this file, e.g.
`2026-11-23: rotated bypass + dev client secret`, and commit it, or tell the session "rotated".
The session cannot see secret values, so this line is how gate (b) is checked.
- **Done looks like:** Shopify lists one client secret, created today. The bypass secret shows today's date.

## 3. Resend DNS for getdeploi.com (10 min + waiting). Gate (d)
DNS for getdeploi.com is at **Squarespace** (nameservers `nsa1-4.squarespacedns.com`). On 2026-11-22,
`resend._domainkey.getdeploi.com` and `send.getdeploi.com` did not exist.
1. resend.com → Domains → **Add domain** → `getdeploi.com`. Then add `agents.getdeploi.com` and turn on **Receiving**.
2. Squarespace → Domains → getdeploi.com → DNS → Custom records. Add exactly what Resend shows. Normally:
   - `resend._domainkey` TXT (the key)
   - `send` MX `feedback-smtp.<region>.amazonses.com` priority 10
   - `send` TXT `v=spf1 include:amazonses.com ~all`
   - the same three for `.agents`
   - `agents` MX (the inbound host Resend shows)
   - `_dmarc.agents` TXT `v=DMARC1; p=none; rua=mailto:support@getdeploi.com`

   **Do not touch** the root MX (Mailgun), the root SPF or the root `_dmarc`.
3. Wait until Resend shows both domains **Verified**.
4. Vercel → deploi-app → **Production**: add `RESEND_API_KEY` (Sensitive) and `AGENT_MAIL_DOMAIN=agents.getdeploi.com`.
- **Done looks like:** both domains are green **Verified** in Resend.

## 4. Tell the session "gate ready"
It re-checks (a) to (d). If all are true it then:
1. Merges the PR.
2. Sets the production branch to `main` for both projects.
3. Backs up the database, then applies migrations 058 to 065 to deploi-prod (listed first).
4. Deploys both projects from the same SHA.
5. Smoke-tests production with screenshots, and rolls back to the current deployments if anything fails.

## 5. Install the dev app on the dev store and give the session store access (10 min)
1. dev.shopify.com → **Deploi (dev)** → Install app → **james-jwtftl1e**.
2. Put the value of `DEVSTORE_ADMIN_TOKEN` into the cloud environment's secrets under the same name.
   It is already on Vercel Preview, branch `claude/deploi-platform-launch`.
3. Message **"installed"**. The session then runs every store agent on james-jwtftl1e and takes the dashboard + proof
   screenshots and the final 1600×900 listing screenshots inside the real admin.
- **Done looks like:** Apps → Deploi (dev) opens the Deploi home screen inside Shopify with no error.

## 6. Create the production Shopify app "Deploi" (15 min)
Exact values are in `docs/SHOPIFY_PROD_APP.md`.
1. dev.shopify.com → Apps → **Create app** → name **Deploi**.
2. Message the **Client ID** (it is public).
3. Vercel → deploi-app → **Production** only:
   - `SHOPIFY_API_KEY` = the Client ID
   - `SHOPIFY_API_SECRET` = the client secret (Sensitive)
   - `SHOPIFY_APP_URL=https://app.getdeploi.com`
   - `SHOPIFY_API_VERSION=2026-10`
   - `SHOPIFY_APP_HANDLE=deploi`
   - `EMAIL_LIVE_SENDS=off`
   - `BILLING_REQUIRED=false`
4. dev.shopify.com → Settings → Service accounts → create `claude-code-deploi-prod` (App development, **Deploi** only).
   Put its token in the cloud environment as `SHOPIFY_SERVICE_ACCOUNT_TOKEN_PROD`.
5. Message **"production app ready"** with the Client ID. The session links `deploi-app/shopify.app.production.toml`
   and runs `shopify app deploy --config production` (URLs, scopes, webhooks).

**Where to copy the Client ID and secret:** dev.shopify.com → Apps → **Deploi** → **Settings** → **Client credentials**.
- **Client ID** (shown in full) → Vercel → deploi-app → Settings → Environment Variables → Add → Key `SHOPIFY_API_KEY`,
  Environment **Production** only, Type Plain.
- **Secret** (click Reveal / Copy) → same screen → Key `SHOPIFY_API_SECRET`, Environment **Production** only, mark **Sensitive**.
- Then add `SHOPIFY_APP_URL=https://app.getdeploi.com`, `SHOPIFY_API_VERSION=2026-10`, `SHOPIFY_APP_HANDLE=deploi`,
  `BILLING_REQUIRED=false` (Production). They take effect on the next Production deploy (the ship step).
- **Done looks like:** Deploi → Versions shows the released version as **Active**.

## 7. Paste the app settings (5 min)
On **Deploi** only, never on Deploi (dev):
1. Distribution → **Public distribution** → Confirm.
2. Pricing → **Free**.
3. API access → Protected customer data → request **nothing**.

## 8. IP allowlist (5 min). The Shopify deadline was 2026-11-20, so do it on both apps now
1. dev.shopify.com → **Deploi (dev)** → **Settings** → **IP allowlist** → **Manage**.
   - Under ASNs add **16509** and **14618** (Amazon; Vercel's iad1 functions call Shopify from Amazon's network). Countries: **United States**.
   - Click **Save**. Under **Test against recent traffic** click **Run test**: it should say none of your last 30 days of requests would be blocked.
   - Leave **Enforce IP allowlist** off for now. Shopify keeps the list.
   - Screenshot the page and the test result, then add a dated line under "Your confirmations".
2. Do the same on **Deploi**.
3. Turn **Enforcement** on only after the production smoke test.

## 9. Paste the listing (15 min)
Partner Dashboard → Deploi → App listing.
1. Paste from `docs/SHOPIFY_LISTING.md`: name, subtitle, introduction, details, feature bullets, access text,
   search terms, URLs, support email and reviewer test instructions.
2. Upload the icon `deploi-app/docs/app-store/icon-1200.jpg`.
3. Upload the screenshots from step 5 (the session sends them; the drafts are in `docs/listing-screenshots/`).
4. Record the 2–3 minute screencast with the script in `deploi-app/docs/app-store/LISTING.md` §7.

## 10. Two quick legal confirmations
1. **Exact legal name.** The site says "James Investments and real estate holdings LLC". Your message today said
   "James Investments and Real Estate Holdings LLC". Reply with the exact casing on the Ohio filing and the
   session updates `src/lib/brand.ts` and its test.
2. **Counsel sign-off** on https://getdeploi.com/privacy and /terms.

## 11. Submit
Partner Dashboard → Deploi → **Submit for review**. If Shopify asks for a full street address, stop and tell the session.
- **Done looks like:** status **In review**. When approved: Vercel → `STORE_ACCESS_MODE` (Production) → `open` → Redeploy.

---

## Track B (service businesses): only when you want it live. It does not block Shopify

The Missed Call Agent, Booking Agent and the service-business sign-up are built and tested, and **off**
(`OFFICE_PHONE_AGENTS`, `OFFICE_SIGNUP`, `VITE_OFFICE_SIGNUP` unset). To test them for real, with texts only to your phone:

### B1. Open a Twilio account (~30 min, plus 1–3 weeks for US A2P registration)
1. twilio.com → sign up → buy one US local number with SMS + Voice.
2. Console → Messaging → **A2P 10DLC**: register your brand (the LLC) and one campaign ("Customer care / appointment reminders").
   US carriers block business texting without it.

### B2. Put the keys in Vercel, **Preview only** first
- Sensitive: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- Plain:
  - `TWILIO_FROM_NUMBER` = the number
  - `NOTIFY_SMS_PROVIDER=twilio`
  - `NOTIFY_LIVE_SENDS=on`
  - `NOTIFY_ALLOWED_NUMBERS` = **your test mobile only**. In this mode nothing can reach any other number.
  - `OFFICE_PHONE_AGENTS=on`

### B3. Point the Twilio number at Deploi
Twilio → the number:
- **A call comes in** → Webhook POST `https://dev.getdeploi.com/api/webhooks/phone/voice`
- **A message comes in** → Webhook POST `https://dev.getdeploi.com/api/webhooks/phone/sms`

### B4. Tell the session two numbers
1. Your **test mobile** (the only phone that will get texts).
2. The **Twilio number**.

The session connects the line to a test organization and runs the full chain live:
call the number, don't answer, reply to the text, book, reschedule, dispatch, DONE, invoice, payment.

### B5. Sign-up page on the site
Set `VITE_OFFICE_SIGNUP=on` on deploi-site and `OFFICE_SIGNUP=on` on deploi-app. Use Preview first.

### B6. Real tools for Office customers (each optional)
The steps for Microsoft Entra (Outlook), HubSpot, QuickBooks sandbox and the other CRMs are in
`deploi-app/docs/FOUNDER-CLICK-LIST.md` (older numbering 6–12).

---

## Why production did not ship on 2026-11-22
| Gate | Result | Evidence |
|---|---|---|
| (a) `CREDENTIALS_ENCRYPTION_KEY` in Production | **false** | Vercel env list: only on Preview (2 branch-scoped copies) |
| (b) Two exposed secrets rotated, confirmed here | **false** | no confirmation in this file or the ledger. Vercel shows `SHOPIFY_API_SECRET` (Preview) last updated 2026-11-08 |
| (c) Everything green | see `docs/FINISH_LEDGER.md` | |
| (d) Resend DNS verifies | **false** | `resend._domainkey.getdeploi.com`: NXDOMAIN (dns.google, 2026-11-22) |

## Your confirmations
(add a dated line here, e.g. "2026-11-23: rotated bypass + dev client secret")
