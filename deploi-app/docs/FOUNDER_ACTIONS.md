# FOUNDER_ACTIONS: everything that needs you

Each item needs an account, a payment, a decision or a click that only you can make. Everything else is built.
Never paste a secret into chat: put values into Vercel yourself (Project **deploi-app** → Settings → Environment
Variables), with **Sensitive** on, scoped to **Preview** first, and to **Production** only when you approve going live.

`<B>` below means both of these base URLs (add every redirect URI twice):
- `https://deploi-app-git-claude-deploi-operating-system-james-ai.vercel.app` (PR #16 preview)
- `https://app.getdeploi.com` (production)

Order matters for items 1–4: they are the long pole for the Shopify submission.

## 1. Website live (blocks Shopify: the reviewer opens the privacy policy)  ~10 min + DNS propagation
Squarespace → **Domains** → getdeploi.com → **DNS** → **DNS Settings**:
1. Delete the four Squarespace **A** records on `@` and the `www` CNAME to `ext-sq.squarespace.com`
   (if they are locked under "Squarespace Defaults", turn off the Squarespace site for this domain first).
2. Add `@` **A** `216.150.1.1`, `@` **A** `216.150.16.1`, `www` **CNAME** `f7bab32ca6f31b92.vercel-dns-016.com.`
3. Leave `app` (CNAME to Vercel) unchanged.
4. Tell me when it is done; I check `https://getdeploi.com/privacy`, `/terms`, `/support` (read-only).

## 2. Deploi's own support email (blocks Shopify)  ~20 min
The support address used before belonged to another company and must not appear anywhere (a repo test forbids it).
Deploi's should be **support@getdeploi.com**.
1. In your mail provider (Microsoft 365 or Google Workspace), create the mailbox or alias `support@getdeploi.com`.
2. In Squarespace DNS add the provider's MX, SPF (TXT `v=spf1 include:<provider> -all`), DKIM (provider gives the
   CNAME/TXT) and DMARC (TXT `_dmarc` → `v=DMARC1; p=quarantine; rua=mailto:support@getdeploi.com`).
3. Send a test mail to it from an outside account and reply.
4. Tell me; I switch `CONTACT_EMAIL` / `COMPANY_EMAIL` from hello@ to support@ in one commit.

## 3. Shopify Partner: registration fee and app setup  ~30 min
1. Partner Dashboard → **Settings** → Organization → **App Store registration** → **Register** → **Pay now**
   (**$19** one-time; needs the Organization owner/admin role).
2. Partner Dashboard → **Settings** → **Emergency developer contact**: email and phone.
3. Dev Dashboard → app → **Distribution** → **Public distribution (Shopify App Store)** → confirm (permanent).
4. **Protected customer data: opt out** for this first submission. The order-, return- and customer-facing
   commerce agents stay hidden in Shopify until phase 2 (request text ready in `docs/app-store/PROTECTED-CUSTOMER-DATA.md`).
5. Pricing decision: Free for the first submission is fastest (paid needs App Pricing plans tested on a dev store).

## 4. Development store live run (blocks Shopify; nothing here touches real customers)  ~1–2 h
1. Partner Dashboard → **Stores** → **Add store** → **Development store**.
2. Dev Dashboard → app → **Install app** → that store.
3. Tell me; I run `docs/APP-STORE-OPEN-ITEMS.md` §6 and `LISTING.md` §8 against it, capture the 1600×900 screenshots
   and the screencast script, and fix anything that fails.

## 5. Legal sign-off (blocks Shopify)
Counsel reads `/privacy` and `/terms` on the site. When approved, tell me; I set `VITE_LEGAL_REVIEWED=true`.

## 6. Microsoft Entra (Outlook mail + calendar)  ~15 min
entra.microsoft.com → **App registrations** → **New registration**:
1. Name `Deploi`; Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI, platform **Web**: `<B>/api/email/oauth/callback` (add both).
3. **Certificates & secrets** → **New client secret** → copy the Value straight into Vercel.
4. **API permissions** → Microsoft Graph → **Delegated**: `offline_access`, `openid`, `email`, `profile`, `User.Read`,
   `Mail.Send`, `Mail.ReadWrite`, `Calendars.ReadWrite` → **Add**.
5. Vercel: `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `EMAIL_OAUTH_PROVIDERS=on`.
6. Use a test mailbox only (a free outlook.com account is fine).

## 7. HubSpot  ~10 min
developers.hubspot.com → **Apps** → **Create app** → **Auth**:
1. Redirect URL `<B>/api/office/oauth/hubspot/callback`.
2. Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`.
3. Vercel: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`. Test with a free **developer test account**.

## 8. Salesforce  ~15 min
Use a free **Developer Edition** org (developer.salesforce.com/signup). Setup → **App Manager** → **New Connected App**:
1. Enable OAuth Settings; Callback URL `<B>/api/office/oauth/salesforce/callback`.
2. Scopes: **Manage user data via APIs (api)**, **Perform requests at any time (refresh_token, offline_access)**.
3. Tick **Require Proof Key for Code Exchange (PKCE)**. Save, wait ~10 min, **Manage Consumer Details** → copy.
4. Vercel: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` (sandbox org: also `SALESFORCE_LOGIN_URL=https://test.salesforce.com`).

## 9. Pipedrive  ~10 min
Developer Hub (developers.pipedrive.com, free sandbox account) → **Create an app** → **Private app**:
1. Callback URL `<B>/api/office/oauth/pipedrive/callback`.
2. Scopes: **Contacts: full**, **Deals: full**, **Activities: full**, **Users: read**.
3. Vercel: `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`.

## 10. Zoho CRM  ~10 min
api-console.zoho.com → **Add Client** → **Server-based Applications**:
1. Redirect URI `<B>/api/office/oauth/zoho/callback`.
2. **Settings** → enable **Multi-DC**.
3. Vercel: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`. Test with a Zoho CRM free/trial org.

## 11. Intuit QuickBooks (sandbox)  ~10 min
developer.intuit.com → **Dashboard** → **Create an app** → **QuickBooks Online and Payments**:
1. Scope `com.intuit.quickbooks.accounting`.
2. **Keys & credentials** (Development): Redirect URI `<B>/api/office/oauth/quickbooks/callback`.
3. Vercel: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT=sandbox`.
4. A sandbox company is created for you under **Sandbox**; use only that.

## 12. Buildium  ~1 day (vendor-dependent)
1. Request a sandbox at developer.buildium.com (Buildium approves it).
2. In the sandbox account: **Settings** → **Application settings** → **API settings** → **Create API key**,
   read/write on **Rentals**, **Leasing**, **Applicants**, **Tasks**.
3. Paste the key on `/office/connections` (it is encrypted; never in chat). Vercel: `BUILDIUM_ENVIRONMENT=sandbox`.

## 13. Optional: real text and voice updates (Twilio)
Simulated today. To go live: Twilio account → buy a number → A2P 10DLC brand + campaign registration (US) →
Vercel `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`. Steps: `docs/NOTIFY-CHANNELS.md`.

## 14. Partners (later, no code blocker)
Rent Manager, ResMan, Rently: apply through each vendor's partner program (`docs/PARTNERS-PROPERTY.md`). Rent Manager
allow-lists caller IPs, so Deploi needs fixed outbound IPs (Vercel Secure Compute or a proxy) first.

## 15. Your written OK (nothing below happens without it)
- Apply release set 2026-11-07 (migrations 058–062) to **deploi-preview** for a browser run of the new packs.
- Merge PR #16 and this branch's PR; apply migrations to **deploi-prod**; promote to production.
