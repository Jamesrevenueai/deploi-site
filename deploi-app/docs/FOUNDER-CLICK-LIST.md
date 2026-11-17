# Founder click list: only what you have to do yourself (rewritten 2026-11-17)

Everything here needs your login, a secret value, or a choice only you can make. Anything a cloud session can do
from Vercel or GitHub is already done or is not on this list.
Steps are in **deadline order**. Each step says where to click and what you should see when it is done.
Never paste a secret into chat. Paste it only into the Vercel, Shopify or Resend field the step names.

**Already done for you (checked on Vercel on 2026-11-17, names and scopes only):**
- The stale branch `DATABASE_URL`, `AUTH_MODE`, `ALLOW_DEV_LOGIN` and every `claude/jolly-ptolemy-kp7ljd` variable are gone.
- `STORE_ACCESS_MODE=open` and `CREDENTIALS_KEY_ID=prod-k1` are on Production.

App names used below: **Deploi (dev)** is the testing app, never public. **Deploi** is the production app you submit.

---

## 1. Shopify IP allowlist: due **Thursday, 20 November 2026**

Both apps call Shopify from Vercel's servers, so Shopify needs to allow Vercel's network (AWS).

1. Go to dev.shopify.com → organization **deploi ai** → **Deploi (dev)** → **Settings** → **IP allowlist** → **Manage**.
2. Add the ASNs **16509** and **14618** (both Amazon) and the country **United States** → **Save**.
3. Click **Run test**.
   - **Done looks like:** the test shows **0 blocked** requests, and the list shows both ASNs and United States.
4. Leave **Enforcement** off until the in-store test passes (step 4). Then come back, turn it on, and run the test once more: still 0 blocked.
5. If the production app **Deploi** already exists (step 5), repeat 1 to 3 on it. Turn its enforcement on only after the production smoke test.

If the Shopify screen asks for IP ranges instead of ASNs, stop and send the cloud session a screenshot of the page.
It will look up Vercel's current outbound ranges.

---

## 2. Replace the two exposed secrets: do this **today**

**2a. The Vercel protection bypass secret.** It was in the old Deploi (dev) URLs inside Shopify and was printed in a session log.
1. vercel.com → team **JamesAi** → project **deploi-app** → **Settings** → **Deployment Protection**.
2. Under **Protection Bypass for Automation**, click **Regenerate** (or **Revoke**, then **Create**).
3. **Done looks like:** the secret shown is different from before, created today.
   Nothing else needs changing: the app no longer uses the bypass, and the old preview URLs are blocked by the firewall rule "Previews only via dev.getdeploi.com".

**2b. The Deploi (dev) Shopify client secret.** The old one was shared in chat.
1. dev.shopify.com → **Deploi (dev)** → **Settings** → **Client credentials** → **Create new secret**. Keep the old one for now.
2. Copy the new secret straight into vercel.com → **deploi-app** → **Settings** → **Environment Variables** → `SHOPIFY_API_SECRET` (Preview) → **Edit** → paste → **Save**.
3. **Deployments** → the newest Preview deployment → **⋯** → **Redeploy**.
4. Open https://dev.getdeploi.com: it should redirect to `/login`. That is correct.
5. Back in Shopify, **Revoke** the old secret.
   - **Done looks like:** Shopify lists one secret, created today. Opening the app in the dev store still loads, with no "invalid HMAC" or 401 error.

---

## 3. Production encryption key: decide before the first real store installs

`CREDENTIALS_ENCRYPTION_KEY` is missing on Production. Shopify tokens are encrypted with it.
**Do not create a new key until you have checked that nothing in production was encrypted with an earlier one.** A new key cannot read anything stored with an old key.

1. supabase.com → project **deploi-prod** → **SQL Editor** → **New query** → paste this and click **Run**. It only reads:
   ```sql
   select c.table_name,
          (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.table_name), false, true, '')))[1]::text::int as rows
   from information_schema.columns c
   where c.table_schema = 'public' and c.column_name = 'key_id'
   order by 1;
   ```
2. **If every `rows` value is 0:** generate a key with your password manager (32 random bytes, base64) or `openssl rand -base64 32` on your computer.
   Then vercel.com → **deploi-app** → **Environment Variables** → **Add**: key `CREDENTIALS_ENCRYPTION_KEY`, the value you generated, **Production** only, **Sensitive** on → **Save**. Keep a copy in your password manager, labelled "prod-k1".
   - **Done looks like:** the variable is listed for Production with the lock icon, next to `CREDENTIALS_KEY_ID=prod-k1`.
3. **If any `rows` value is above 0:** stop. Do not add a new key. Find the key those rows were written with (your password manager, "prod-k1") and add that one instead.

---

## 4. Install the dev app and run the in-store test

1. dev.shopify.com → **Deploi (dev)** → **Install app** → choose the development store **james-jwtftl1e**.
   - **Done looks like:** the store admin opens **Apps → Deploi (dev)** and shows the Deploi home screen inside Shopify, with no error banner.
2. The cloud session drives the in-store test through the dev-store harness. It needs `DEVSTORE_ADMIN_TOKEN`, which is already on Vercel (Preview, branch `claude/deploi-platform-launch`). Put the **same value** in the cloud environment's secrets under the same name.
3. Message the cloud session **"installed"**.
   - **Done looks like:** it sends back the test report. When it says testing is over, delete `DEVSTORE_ADMIN_TOKEN` from Vercel and from the cloud environment.

---

## 5. Create the production Shopify app (needed before you submit)

1. dev.shopify.com → **Apps** → **Create app** → name **Deploi** → **Create**. Send the **Client ID** to the cloud session. It is public.
2. **Deploi** → **Settings** → **Client credentials**: copy the **Client secret** straight into Vercel (next step). Paste it nowhere else.
3. vercel.com → **deploi-app** → **Environment Variables** → add these, **Production only**, with Sensitive on for the secret:
   - `SHOPIFY_API_KEY` = the Deploi Client ID
   - `SHOPIFY_API_SECRET` = the Deploi Client secret
   - `SHOPIFY_APP_URL` = `https://app.getdeploi.com`
   - `SHOPIFY_API_VERSION` = `2026-10`
   - `SHOPIFY_APP_HANDLE` = `deploi`
   - `EMAIL_LIVE_SENDS` = `off`
4. dev.shopify.com → **Settings** → **Service accounts** → create `claude-code-deploi-prod` with access **App development** for **Deploi** only (not Deploi (dev)). Add its token to the cloud environment as `SHOPIFY_SERVICE_ACCOUNT_TOKEN_PROD`.
5. Message the cloud session **"production app ready"**. It links and releases `shopify.app.deploi.toml` and sends you the version name.
   - **Done looks like:** dev.shopify.com → Deploi → **Versions** shows that version as **Active**.

---

## 6. Settings only on Deploi (production), never on Deploi (dev)

1. **Distribution** → **Public distribution (Shopify App Store)** → **Confirm**. This is permanent.
2. **Pricing** → **Free**.
3. **API access** → **Protected customer data** → request nothing. The app asks for no customer or order data.
4. Store access during review (Vercel → deploi-app → Environment Variables → `STORE_ACCESS_MODE`, Production). Pick one:
   - `open` (what is set now): every store that installs can be changed. Reviewers never get stuck.
   - `review` (new, 2026-11-17): only Shopify development stores, and stores you approve on https://app.getdeploi.com/staff/store-access, can be changed. Real merchants who find the listing during review are protected. If a reviewer says they cannot make changes, approve their store on that page.
   - After the listing is approved: set it to `open` and **Redeploy** Production.
   - **Done looks like:** https://app.getdeploi.com/staff/store-access says "Mode: open" or "Mode: review".

---

## 7. Email sending (after go-live, before `EMAIL_LIVE_SENDS` goes on)

Receiving mail at support@ already works. Sending stays off until this is done.

1. resend.com → **Domains** → **Add domain** → `getdeploi.com`. Then **Add domain** → `agents.getdeploi.com`, and turn on **Receiving** for it.
2. Squarespace → **Domains** → **getdeploi.com** → **DNS** → **Custom records**. Add **exactly** what Resend shows for each domain. It is normally the table below. The `p=…` keys and the region come from Resend.

   | Host (Squarespace) | Type | Value | Priority |
   |---|---|---|---|
   | `resend._domainkey` | TXT | the `p=…` key Resend shows for **getdeploi.com** | |
   | `send` | MX | `feedback-smtp.<region>.amazonses.com` (as Resend shows) | 10 |
   | `send` | TXT | `v=spf1 include:amazonses.com ~all` | |
   | `resend._domainkey.agents` | TXT | the `p=…` key Resend shows for **agents.getdeploi.com** | |
   | `send.agents` | MX | `feedback-smtp.<region>.amazonses.com` (as Resend shows) | 10 |
   | `send.agents` | TXT | `v=spf1 include:amazonses.com ~all` | |
   | `agents` | MX | the receiving host Resend shows (for example `inbound-smtp.<region>.amazonaws.com`) | as shown |
   | `_dmarc.agents` | TXT | `v=DMARC1; p=none; rua=mailto:support@getdeploi.com; adkim=s; aspf=r` | |

   **Do not change** the root `@` MX (Mailgun), the root SPF or the root `_dmarc` record.
   Sending is safe under the root's strict DMARC because Resend signs with `d=getdeploi.com` (and `d=agents.getdeploi.com`), which aligns exactly.
3. Wait until Resend shows both domains **Verified**. That takes minutes, or up to 72 hours.
4. Vercel → deploi-app → Production: add `RESEND_API_KEY` (Resend → **API Keys**, send permission, Sensitive on) and `AGENT_MAIL_DOMAIN=agents.getdeploi.com`.
   - **Done looks like:** both domains show green **Verified** in Resend. Message the cloud session **"resend done"**. It sends one test message to your own address and shows you SPF, DKIM and DMARC all **pass**.

---

## 8. Submit

Once the cloud session has sent the submission package and your in-store test has passed: Partner Dashboard → **Deploi** → **App listing** → **Submit for review**.
If Shopify asks for a full public street address, stop and tell the cloud session first.
- **Done looks like:** the listing status reads **In review**.

---

## Housekeeping with dates

- **On or after 29 November 2026:** drop the archived care tables (`docs/PRODUCTION-LAUNCH-2026-10-30.md`, "TODO: drop the archive"). The cloud session runs it once you say "drop the archive".
- **Any time:** delete the old preview deployments that the firewall rule now blocks (Vercel → deploi-app → Deployments → filter Preview → older than 2026-11-08 → Delete).
