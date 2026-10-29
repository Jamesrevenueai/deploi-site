# Launch steps, click by click

These are the changes only you can make. Menu names are as of October 2026. If a label has moved, the setting is the same. Background and reasons are in `LAUNCH-DNS.md`, `PRODUCTION-SAFETY.md` and `RELEASE-PLAN.md`.

## The whole sequence (updated 2026-10-29)

| # | Step | Where | Blocks |
|---|---|---|---|
| 0 | **Close the public dev sign-in** (remove `AUTH_MODE`/`ALLOW_DEV_LOGIN` from Production, rotate `APP_SECRET` per environment, redeploy, verify) | `PRODUCTION-SAFETY.md` §2 | everything; it is live today |
| 0a | A mailbox for `hello@getdeploi.com`, or a receivable `STAFF_EMAILS` address (getdeploi.com has **no MX record**) | your email provider | staff sign-in after step 0 |
| 1 | Protect `main` | below | safe merging |
| 2 | Resend: verify `agents.getdeploi.com` and the root domain | below | any real email |
| 3 | Move getdeploi.com to the new website | below | public site |
| 4 | Back up production and apply migrations 28–34 | `RELEASE-PLAN.md` §3 | merging anything into `main` |
| 5 | Create the Shopify app in the Dev Dashboard and set `SHOPIFY_*` and `CREDENTIALS_*` in Vercel | `RELEASE-PLAN.md` §4, `SHOPIFY-SETUP.md` | Shopify installs |
| 6 | Merge in order: #2, then new PR → #3 → #1 | `RELEASE-PLAN.md` §2 | production platform |
| 7 | Run the development-store test, and name the test mailbox for the email test | `DEV-STORE-CHECKLIST.md`, `EMAIL-SETUP.md` | beta |
| 8 | Grant beta stores write access one by one | `RELEASE-PLAN.md` §5 | beta merchants making changes |
| 9 | Decisions: pricing (free beta proposed), legal review, app icon, listing | `APP-STORE-OPEN-ITEMS.md` | public listing |

## 1. Protect `main` on GitHub (5 minutes)

This stops anyone, me included, from pushing straight to `main` and redeploying production.

1. Open `https://github.com/Jamesrevenueai/deploi-site`.
2. Click **Settings** (top bar, far right), then **Rules → Rulesets** in the left menu.
3. Click **New ruleset → New branch ruleset**.
4. **Ruleset name:** `protect main`. **Enforcement status:** **Active**.
5. Under **Target branches**, click **Add target → Include default branch** (this is `main`).
6. Under **Branch rules**, tick:
   - **Restrict deletions**
   - **Block force pushes**
   - **Require a pull request before merging**, with **Required approvals** set to `1`. Also tick **Dismiss stale pull request approvals when new commits are pushed**.
   - **Require status checks to pass**, if you want Vercel's preview build to be required. Click **Add checks** and choose the Vercel checks that appear on PRs.
7. Leave **Bypass list** empty, so the rule applies to admins too.
8. Click **Create**.

Check: try `git push origin main` with any commit. GitHub refuses it with "Changes must be made through a pull request".

If your plan shows **Settings → Branches → Add classic branch protection rule** instead, use branch name pattern `main` and tick the same options: require a pull request with 1 approval, require status checks, do not allow bypassing, and leave force pushes and deletions off.

## 2. Resend: verify `agents.getdeploi.com` (15 minutes, then waiting on DNS)

DNS for getdeploi.com is at Squarespace, so every record below goes in **Squarespace → Domains → getdeploi.com → DNS → DNS Settings → Custom records → Add record**. Squarespace hosts are written relative to `getdeploi.com`. For example, host `send.agents` means `send.agents.getdeploi.com`.

1. Sign in to `https://resend.com` → **Domains** → **Add Domain**.
2. **Name:** `agents.getdeploi.com`. **Region:** pick the one nearest your merchants (`us-east-1` or `eu-west-1`). Click **Add**.
3. On the domain page, turn on **Receiving** (sometimes called Inbound). Resend then adds an MX record to the list.
4. Resend now shows a table of records. Copy each one into Squarespace exactly as Resend shows it. The names and types are fixed. Two values are generated for your domain and region, so they must come from Resend: the DKIM key and the MX hosts.

   | Squarespace host | Type | Priority | Value | Copy from Resend? |
   |---|---|---|---|---|
   | `resend._domainkey.agents` | TXT | — | `p=MIGfMA0G…` (one long line) | **Yes: the whole value** |
   | `send.agents` | MX | `10` | `feedback-smtp.<region>.amazonses.com` | **Yes: the host** |
   | `send.agents` | TXT | — | `v=spf1 include:amazonses.com ~all` | Check it matches |
   | `agents` | MX | `10` (or what Resend shows) | the receiving host Resend shows | **Yes: the host** |
   | `_dmarc.agents` | TXT | — | `v=DMARC1; p=none; rua=mailto:dmarc@getdeploi.com; adkim=s; aspf=r` | No: this one is ours, copy it from here |

   Notes:
   - If Squarespace adds `.getdeploi.com` to the host for you, type only the part shown in the first column.
   - Do not touch the existing `@` SPF (`v=spf1 -all`) or `_dmarc` (`p=reject`) records. They protect the main domain. The `_dmarc.agents` record overrides them for the agents subdomain only.
   - `rua=mailto:dmarc@getdeploi.com` only works if that mailbox exists. If it does not, delete `rua=mailto:dmarc@getdeploi.com; ` from the value.
5. Back in Resend, click **Verify DNS Records**. Wait until every row says **Verified**. This often takes minutes and can take up to 72 hours.
6. In Resend → **Webhooks → Add Endpoint**:
   - URL: `https://app.getdeploi.com/api/webhooks/agent-mail`
   - Event: `email.received`
   - Then copy the **Signing Secret** (`whsec_…`).
7. In Resend → **API Keys → Create API Key**: name it `deploi-app production`, with **Sending access** for `agents.getdeploi.com` only. Copy the key.
8. In Vercel → `deploi-app` → **Settings → Environment Variables** → Production, add:
   - `AGENT_MAIL_DOMAIN=agents.getdeploi.com`
   - `RESEND_API_KEY=` the key from step 7
   - `AGENT_MAIL_WEBHOOK_SECRET=` the secret from step 6
   - `EMAIL_LIVE_SENDS=off`

   Leave sends off until the test in `DEV-STORE-CHECKLIST.md` passes, and do not redeploy until you approve.

For `hello@getdeploi.com` (the weekly summary sender), repeat steps 1 to 5 with the name `getdeploi.com`. That adds `resend._domainkey`, `send` MX and `send` TXT records on the root. Skip Receiving and skip the DMARC row.

Checked 2026-10-29 (public DNS): the root has `v=spf1 -all`, `_dmarc` `p=reject; sp=reject; adkim=s; aspf=s`, **no MX**, and no Resend records on `agents` or the root. With strict DKIM alignment, mail from `hello@getdeploi.com` is rejected by receivers until the root domain is verified in Resend; the agent subdomain passes once its own DKIM record is verified, because Resend signs with `d=agents.getdeploi.com`. Receiving mail at `hello@getdeploi.com` needs a mailbox provider's MX records (step 0a); add those as Custom records and keep them when moving the website (step 3).

## 3. Move getdeploi.com off Squarespace to the new website (10 minutes, then waiting on DNS)

This keeps the domain registered at Squarespace and only changes where it points. The site is the Vercel project `deploi-site`.

1. **Squarespace → Domains → getdeploi.com.** If the domain is connected to a Squarespace site, open **Website** (or **Domain settings → Connected site**) and choose **Disconnect**. This frees the Squarespace default records.
2. **DNS → DNS Settings.** Under **Squarespace Defaults**, delete these records with the trash icon:
   - the four **A** records on `@`: `198.185.159.144`, `198.185.159.145`, `198.49.23.144`, `198.49.23.145`;
   - the **CNAME** on `www` pointing at `ext-sq.squarespace.com`.
3. Under **Custom records → Add record**, add:

   | Host | Type | Value |
   |---|---|---|
   | `@` | A | `216.150.1.1` |
   | `@` | A | `216.150.16.1` |
   | `www` | CNAME | `f7bab32ca6f31b92.vercel-dns-016.com` |

4. Do **not** touch `app` (the CNAME to Vercel for the app), the SPF or DMARC records, or the Resend records from step 2.
5. Open Vercel → `deploi-site` → **Settings → Domains**. Wait until `getdeploi.com` and `www.getdeploi.com` both say **Valid Configuration**. Vercel issues the certificates on its own.
6. Check from any terminal:

   ```
   curl -sI https://getdeploi.com | grep -i server        # server: Vercel
   curl -sI https://www.getdeploi.com | grep -i location   # location: https://getdeploi.com/
   ```

Which version of the website answers depends on the Vercel production deployment of `deploi-site`, which is currently the rolled-back `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY`. Moving DNS does not deploy anything new.

To undo: delete the three records from step 3 and reconnect the Squarespace site. Squarespace restores its defaults.
