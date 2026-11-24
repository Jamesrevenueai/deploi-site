# Environment preflight (deploi-app)

Generated 2026-11-24 from the code (every `process.env` read in `app/`, `lib/`, `components/`, `instrumentation.ts`) and the Vercel env list for deploi-app. Names only, never values.

## What you must still add to Vercel → deploi-app → Production

**Before the Shopify submission (required):**

| Key (exact) | Value |
|---|---|
| `SHOPIFY_API_KEY` | Client ID of the new "Deploi" app |
| `SHOPIFY_API_SECRET` | Client secret of "Deploi" (Sensitive) |
| `SHOPIFY_APP_URL` | https://app.getdeploi.com |
| `SHOPIFY_API_VERSION` | 2026-10 |
| `SHOPIFY_APP_HANDLE` | deploi |
| `BILLING_REQUIRED` | false (Free at launch) |
| `EMAIL_LIVE_SENDS` | off until Resend verifies, then on |
| `RESEND_API_KEY` | from resend.com (Sensitive) |
| `AGENT_MAIL_DOMAIN` | agents.getdeploi.com |
| `SYSTEM_MAIL_DOMAIN` | getdeploi.com |
| `UNSUBSCRIBE_SECRET` | any random 32+ characters (Sensitive) |
| `AGENT_MAIL_WEBHOOK_SECRET` | from Resend inbound webhook (Sensitive) |

**For Office billing (only when you sell Office plans):**

| Key (exact) | Value |
|---|---|
| `STRIPE_SECRET_KEY` | sk_test_ first, sk_live_ at launch |
| `STRIPE_WEBHOOK_SECRET` | whsec_ from the Stripe webhook endpoint |
| `BILLING_MODE` | test (then live) |

**Must stay absent in Production:** `AUTH_MODE`, `ALLOW_DEV_LOGIN`, `DEVSTORE_ADMIN_TOKEN`, `DEMO_CONTROLS` (checked 2026-11-24: all absent).
Connection keys (QuickBooks, Microsoft/Outlook, Google, HubSpot, Pipedrive, Salesforce, Zoho, Twilio) are needed only when that connection is offered; none is set anywhere today.

## Every variable the code reads (124)

| Name | Prod | Preview | Required by |
|---|---|---|---|
| `AGENT_MAIL_DOMAIN` | — | branch only | Agent mailboxes |
| `AGENT_MAIL_WEBHOOK_SECRET` | — | — | Inbound agent mail |
| `AI_API_KEY` | — | — | AI model |
| `AI_AUTH_HEADER` | — | — | AI model |
| `AI_ENDPOINT` | — | — | AI model |
| `AI_EXTRA_HEADERS` | — | — | AI model |
| `AI_MODEL_COMPLEX` | — | — | AI model |
| `AI_MODEL_ROUTINE` | — | — | AI model |
| `AI_PRICES` | — | — | AI model |
| `AI_PROVIDER` | — | branch only | AI model |
| `ALLOW_DEV_LOGIN` | — | — | Dev sign-in (must be absent in Prod) |
| `APP_SECRET` | yes | yes | Sessions |
| `APP_URL` | — | — | Tuning / optional (has a default) |
| `AUTH_MODE` | — | — | Dev sign-in (must be absent in Prod) |
| `BILLING_GRACE_DAYS` | — | — | Billing |
| `BILLING_MODE` | — | — | Billing |
| `BILLING_REQUIRED` | — | — | Billing |
| `BUILDIUM_ENABLED` | — | — | Buildium connection |
| `BUILDIUM_ENVIRONMENT` | — | — | Buildium connection |
| `COMPETITOR_MIN_INTERVAL_MS` | — | — | Tuning / optional (has a default) |
| `CREDENTIALS_ENCRYPTION_KEY` | yes | branch only | Stored-credential encryption |
| `CREDENTIALS_KEY_ID` | yes | branch only | Stored-credential encryption |
| `CREDENTIALS_PREVIOUS_KEYS` | — | — | Stored-credential encryption |
| `CREW_LINK_SECRET` | — | — | Crew links (Office) |
| `CREW_LINK_TTL_HOURS` | — | — | Tuning / optional (has a default) |
| `CRON_SECRET` | yes | yes | Scheduled jobs |
| `CSP_REPORT_URI` | — | — | Tuning / optional (has a default) |
| `DATABASE_URL` | yes | — | Database |
| `DATABASE_URL_POOLED` | — | yes | Database (Preview) |
| `DEMO_CONTROLS` | — | branch only | Demo controls (never Prod) |
| `DEPLOI_ENV` | — | — | Tuning / optional (has a default) |
| `DEVSTORE_ADMIN_TOKEN` | — | branch only | Dev-store harness (never Prod) |
| `DISCOVERY_DETECTOR_TIMEOUT_MS` | — | — | Tuning / optional (has a default) |
| `EMAIL_FIRST_CONTACT_MAILBOX_DAILY` | — | — | Email |
| `EMAIL_FIRST_CONTACT_SENDER_DAILY` | — | — | Email |
| `EMAIL_GRAPH_PUSH` | — | — | Email |
| `EMAIL_GRAPH_PUSH_URL` | — | — | Email |
| `EMAIL_LIVE_SENDS` | — | branch only | Email |
| `EMAIL_OAUTH_PROVIDERS` | — | — | Email |
| `EMAIL_OAUTH_REDIRECT_URL` | — | — | Email |
| `EMAIL_ORG_DAILY_CAP` | — | — | Email |
| `EMAIL_TEST_RECIPIENTS` | — | — | Email |
| `GMAIL_PUSH_AUDIENCE` | — | — | Gmail push |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | — | — | Gmail push |
| `GMAIL_PUSH_TOPIC` | — | — | Gmail push |
| `GOOGLE_CALENDAR_CLIENT_ID` | — | — | Gmail/Calendar connection |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | — | — | Gmail/Calendar connection |
| `GOOGLE_CALENDAR_REDIRECT_URL` | — | — | Gmail/Calendar connection |
| `GOOGLE_OAUTH_CLIENT_ID` | — | — | Gmail/Calendar connection |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | — | Gmail/Calendar connection |
| `HUBSPOT_CLIENT_ID` | — | — | HubSpot connection |
| `HUBSPOT_CLIENT_SECRET` | — | — | HubSpot connection |
| `HUBSPOT_REDIRECT_URL` | — | — | HubSpot connection |
| `INVITE_SECRET` | — | — | Team invites |
| `JOBS_PAUSED` | — | — | Tuning / optional (has a default) |
| `LEGAL_DOCS_DIR` | — | — | Legal gate |
| `LEGAL_GATE` | — | — | Legal gate |
| `LEGAL_REQUIRE_PILOT` | — | — | Legal gate |
| `LIVE_WRITES` | — | — | Tuning / optional (has a default) |
| `MICROSOFT_OAUTH_CLIENT_ID` | — | — | Outlook connection |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | — | — | Outlook connection |
| `MICROSOFT_OAUTH_TENANT` | — | — | Outlook connection |
| `MORNING_HOURLY_USD` | — | — | Tuning / optional (has a default) |
| `NEXT_PUBLIC_APP_URL` | yes | yes | Links, redirects |
| `NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD` | — | — | Tuning / optional (has a default) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | — | Sign-in (Supabase) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | yes | Sign-in (Supabase) |
| `NOTIFY_ALLOWED_NUMBERS` | — | — | Owner texts |
| `NOTIFY_LIVE_SENDS` | — | — | Owner texts |
| `NOTIFY_SMS_PROVIDER` | — | — | Owner texts |
| `OPS_LOG_RETENTION_DAYS` | — | — | Tuning / optional (has a default) |
| `PIPEDRIVE_CLIENT_ID` | — | — | Pipedrive connection |
| `PIPEDRIVE_CLIENT_SECRET` | — | — | Pipedrive connection |
| `PIPEDRIVE_REDIRECT_URL` | — | — | Pipedrive connection |
| `PLANS_CACHE_MS` | — | — | Tuning / optional (has a default) |
| `PRICING_APPROVER_EMAILS` | — | — | Tuning / optional (has a default) |
| `PUBLIC_API_ALLOWED_ORIGINS` | yes | yes | Site forms (CORS) |
| `PUBLIC_FETCH_PROXY` | — | — | Tuning / optional (has a default) |
| `QUICKBOOKS_CLIENT_ID` | — | — | QuickBooks connection |
| `QUICKBOOKS_CLIENT_SECRET` | — | — | QuickBooks connection |
| `QUICKBOOKS_ENVIRONMENT` | — | — | QuickBooks connection |
| `QUICKBOOKS_MINOR_VERSION` | — | — | QuickBooks connection |
| `QUICKBOOKS_REDIRECT_URL` | — | — | QuickBooks connection |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | — | — | QuickBooks connection |
| `RESEND_API_KEY` | — | — | Email (Resend) |
| `SALESFORCE_API_VERSION` | — | — | Salesforce connection |
| `SALESFORCE_CLIENT_ID` | — | — | Salesforce connection |
| `SALESFORCE_CLIENT_SECRET` | — | — | Salesforce connection |
| `SALESFORCE_LOGIN_URL` | — | — | Salesforce connection |
| `SALESFORCE_REDIRECT_URL` | — | — | Salesforce connection |
| `SHOPIFY_API_KEY` | — | branch only | Shopify app |
| `SHOPIFY_API_SECRET` | — | yes | Shopify app |
| `SHOPIFY_API_VERSION` | — | branch only | Shopify app |
| `SHOPIFY_APP_HANDLE` | — | — | Shopify app |
| `SHOPIFY_APP_URL` | — | branch only | Shopify app |
| `SHOPIFY_OPTIONAL_SCOPES` | — | — | Shopify app |
| `SHOPIFY_PARTNER_API_TOKEN` | — | — | Shopify app |
| `SHOPIFY_PARTNER_API_VERSION` | — | — | Shopify app |
| `SHOPIFY_PARTNER_APP_ID` | — | — | Shopify app |
| `SHOPIFY_PARTNER_ID` | — | — | Shopify app |
| `SHOPIFY_SCOPES` | — | — | Shopify app |
| `SHOPIFY_WEBHOOK_DEBOUNCE_MS` | — | — | Shopify app |
| `SHOPIFY_WEBHOOK_MAX_DELAY_MS` | — | — | Shopify app |
| `STAFF_EMAILS` | yes | yes | Staff sign-in |
| `STORE_ACCESS_MODE` | yes | — | Store access mode |
| `STRIPE_MAX_RETRIES` | — | — | Office billing (Stripe) |
| `STRIPE_PRICE_GROWTH_MONTHLY` | — | — | Office billing (Stripe) |
| `STRIPE_PRICE_PRO_MONTHLY` | — | — | Office billing (Stripe) |
| `STRIPE_PRICE_STARTER_MONTHLY` | — | — | Office billing (Stripe) |
| `STRIPE_SECRET_KEY` | — | — | Office billing (Stripe) |
| `STRIPE_WEBHOOK_SECRET` | — | — | Office billing (Stripe) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Database admin |
| `SUPPORT_INBOX` | — | — | Support email |
| `SYSTEM_MAIL_DOMAIN` | — | — | System email |
| `TWILIO_ACCOUNT_SID` | — | — | Texts/calls (Twilio) |
| `TWILIO_AUTH_TOKEN` | — | — | Texts/calls (Twilio) |
| `TWILIO_FROM_NUMBER` | — | — | Texts/calls (Twilio) |
| `TWILIO_MESSAGING_SERVICE_SID` | — | — | Texts/calls (Twilio) |
| `UNSUBSCRIBE_SECRET` | — | — | Email unsubscribe links |
| `VERIFY_DELAY_MS` | — | — | Tuning / optional (has a default) |
| `ZOHO_CLIENT_ID` | — | — | Zoho connection |
| `ZOHO_CLIENT_SECRET` | — | — | Zoho connection |
| `ZOHO_DEFAULT_DC` | — | — | Zoho connection |
| `ZOHO_REDIRECT_URL` | — | — | Zoho connection |
