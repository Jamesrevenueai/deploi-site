# Connections: setup for each provider

Status of everything in this document: **built and tested against a fake HTTP layer only**. No provider below has been
exercised against a live account or sandbox from this codebase. Each provider's "Sandbox steps" section is the first
live check to run before launch.

Two app URLs are registered with every provider (register both, exactly):

| Environment | Base URL |
| --- | --- |
| PR #16 preview | `https://deploi-app-git-claude-deploi-operating-system-james-ai.vercel.app` |
| Production | `https://app.getdeploi.com` |

`<BASE>` below means each of them. A missing client id or secret means the provider shows as "Not available yet" to
customers and as "not configured" (with the missing variable names) to staff at `/staff/integrations`. Every stored
token or key is encrypted with `CREDENTIALS_ENCRYPTION_KEY` (AES-256-GCM, bound to the connection id).

How it fits together:

- OAuth providers: `POST /api/office/connections { op: 'connect', provider }` returns the consent URL; the provider
  redirects to `/api/office/oauth/<provider>/callback`. The state is single-use, expires in 10 minutes and is bound to
  the organization and the user who started it. Salesforce and Google use PKCE (S256).
- Tokens refresh 5 minutes before they expire, and once more whenever the provider answers 401 (the call is then
  repeated once). A refused refresh marks the connection "Needs reconnecting" in the integration hub.
- Disconnect revokes at the provider where it has an API for it, then deletes the stored tokens and cancels queued
  work that needed the connection.
- Change detection: the `connections.poll` job (every 10 minutes, from `/api/cron/jobs`) polls CRMs, QuickBooks (CDC)
  and Buildium, and the Outlook calendar delta. Each change becomes one agent event (`lib/connections/events.ts`),
  recorded once per (organization, source, record id + version) in `connection_events`. New Outlook mail emits
  `mail.received`, and lead notification emails emit `lead.email` (`lib/leads/email-parsers.ts`).
- Message text and privacy: `mail.received` carries ids, the sender and the subject, never the text. The inbox sync
  stores the subject and text encrypted in `email_inbound` (AAD `email-inbound:<row id>`). An agent that needs the
  words (a renter's answers, a picked time, a vendor's "decline", an opt-out) reads them with
  `lib/email/message-text.ts` (`readInboundText` / `withInboundText`) at the moment it handles the event: decrypted
  in-process for that handler only, never written to `agent_events` or `connection_events`, never logged. A
  quarantined message is never handed to an agent; a missing or purged one reads as no text.
- Integration hub (`/store/integrations`, `/office/connections`): status, a read-only "Test" probe, Reconnect and
  Disconnect for every provider. "Sandbox only" is shown when QuickBooks, Buildium or Salesforce point at a sandbox.

---

## Microsoft 365 / Outlook (mail and calendar)

- **Flow:** Microsoft identity platform v2, authorization code + PKCE, tenant `common` (work, school and personal
  accounts), `prompt=select_account`.
- **Scopes:** `openid email profile offline_access User.Read Mail.Send Mail.ReadWrite Calendars.ReadWrite` when the
  owner connects "mail and calendar" (`calendar: true`); the older send-only / reply-reading connections keep their
  narrower scopes.
- **Redirect URI (type Web):** `<BASE>/api/email/oauth/callback`
- **Env vars:** `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `EMAIL_OAUTH_PROVIDERS=on`,
  optional `MICROSOFT_OAUTH_TENANT` (default `common`), `EMAIL_OAUTH_REDIRECT_URL`, `EMAIL_GRAPH_PUSH_URL`.
- **What is built:** new mail by delta query (inbox + sent items, `lib/email/readers/microsoft.ts`), send and reply
  (`lib/email/adapters/microsoft.ts`), calendar list / create (with `transactionId`, so a retried create makes no
  duplicate) / update / cancel and calendar delta (`lib/outlook/calendar.ts`), refresh before expiry and on 401.
- **Revoke:** Microsoft Graph has no endpoint for an app to revoke one user's grant to itself (`revokeSignInSessions`
  signs the user out everywhere, so Deploi does not call it). Disconnect deletes the tokens; the owner removes the
  app at https://myapps.microsoft.com (or an admin in Entra > Enterprise applications).
- **Official MCP:** Microsoft has published MCP servers for parts of Microsoft 365 (to confirm availability and scope);
  Deploi calls Graph directly.
- **Sandbox steps:** join the Microsoft 365 Developer Program (free E5 sandbox tenant, if your account qualifies), or use
  a test mailbox; connect it, send a mail to it, check `mail.received` in `connection_events`; create an event in
  Outlook and check `calendar.changed` after the next poll.

## HubSpot

- **Flow:** OAuth 2.0 authorization code (no PKCE), public app.
- **Scopes:** `crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write`
- **Redirect URI:** `<BASE>/api/office/oauth/hubspot/callback`
- **Env vars:** `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, optional `HUBSPOT_REDIRECT_URL`.
- **Built:** leads, contacts (find by email, create, update), notes, tasks, deal stage, changed contacts poll,
  refresh (before expiry and on 401), revoke on disconnect (`DELETE /oauth/v1/refresh-tokens/{token}`).
- **Official MCP:** HubSpot offers an official MCP server (remote, OAuth); Deploi uses the CRM v3 REST API.
- **Sandbox steps:** create a developer test account in the HubSpot developer portal, install the app there, connect.

## Salesforce

- **Flow:** OAuth 2.0 web server flow with PKCE; scopes `api refresh_token`; `instance_url` from the token answer is
  bound to the connection (only `*.my.salesforce.com` hosts are accepted).
- **Redirect URI (Callback URL):** `<BASE>/api/office/oauth/salesforce/callback`
- **Env vars:** `SALESFORCE_CLIENT_ID` (consumer key), `SALESFORCE_CLIENT_SECRET` (consumer secret), optional
  `SALESFORCE_LOGIN_URL=https://test.salesforce.com` for sandbox orgs (shows "Sandbox only"), `SALESFORCE_API_VERSION`
  (default `v62.0`), `SALESFORCE_REDIRECT_URL`.
- **Built:** Lead / Contact / Opportunity / Task / Note get, create, update; SOQL query; find by email (contact first,
  then unconverted lead); upsert (creates a Lead with the required LastName and Company); tasks; notes; opportunity
  stage; changed people poll; refresh on 401 (Salesforce does not report token lifetime); revoke on disconnect.
- **Official MCP:** Salesforce has announced hosted MCP support for its platform (to confirm availability); Deploi uses REST.
- **Sandbox steps:** sign up for a free Developer Edition org, create the connected app there, connect; check a Lead
  created by `upsertContact` appears in the org.

## Pipedrive

- **Flow:** OAuth 2.0 authorization code (HTTP Basic client credentials at the token endpoint). Scopes are chosen on
  the app in Developer Hub: **contacts:full, deals:full, activities:full, users:read**. The token answer's
  `api_domain` (`https://<company>.pipedrive.com`) is bound to the connection.
- **Redirect URI (Callback URL):** `<BASE>/api/office/oauth/pipedrive/callback`
- **Env vars:** `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET`, optional `PIPEDRIVE_REDIRECT_URL`.
- **Built:** persons (search by email, read, create, update), deals (list, create, stage), activities (create,
  list, complete), notes; changed persons poll; refresh (newest refresh token kept); revoke on disconnect.
- **Official MCP:** none known (to confirm); Deploi uses API v2 (v1 for notes).
- **Sandbox steps:** create a free developer sandbox account from Pipedrive Developer Hub, create the app, connect.

## Zoho CRM

- **Flow:** OAuth 2.0 authorization code, `access_type=offline&prompt=consent`. Consent starts on
  `accounts.zoho.com` (or `ZOHO_DEFAULT_DC`); the callback's `accounts-server` names the customer's data center and the
  code is exchanged there. Data centers: `.com` (US), `.eu`, `.in`, `.com.au`. Unknown servers are refused before any call.
- **Scopes:** `ZohoCRM.modules.leads.ALL, ZohoCRM.modules.contacts.ALL, ZohoCRM.modules.deals.ALL,
  ZohoCRM.modules.tasks.ALL, ZohoCRM.modules.notes.ALL, ZohoCRM.org.READ`
- **Redirect URI (Authorized Redirect URIs):** `<BASE>/api/office/oauth/zoho/callback`
- **Env vars:** `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, optional `ZOHO_DEFAULT_DC` (`com`|`eu`|`in`|`com.au`), `ZOHO_REDIRECT_URL`.
  In the API console, enable "Multi-DC" for the client so other data centers can use it.
- **Built:** Leads / Contacts / Deals / Tasks get, create, update, list (If-Modified-Since); search by email; notes;
  deal stage; changed people poll; refresh and revoke at the data center's accounts server.
- **Official MCP:** Zoho offers Zoho MCP (to confirm scope for CRM); Deploi uses CRM REST API v6.
- **Sandbox steps:** a free Zoho CRM edition or a Zoho CRM sandbox; connect one account in `.com` and one in `.eu`.

## QuickBooks Online (Intuit)

- **Flow:** OAuth 2.0 authorization code; scope `com.intuit.quickbooks.accounting`; `realmId` on the callback.
- **Redirect URI:** `<BASE>/api/office/oauth/quickbooks/callback`
- **Env vars:** `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT=sandbox` (sandbox
  companies; shows "Sandbox only"), optional `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`, `QUICKBOOKS_MINOR_VERSION`.
- **Built:** reads (open invoices, invoice, payment, customer, company), **create invoice, record payment, send
  invoice** (each write carries a `requestid`, so a retried write is not applied twice), change data capture poll
  (invoices and payments), refresh (rotating refresh tokens) before expiry and on 401, revoke on disconnect.
  The writes are client capabilities; an agent uses them only through the autonomy/approval layer.
- **Official MCP:** Intuit has published a QuickBooks MCP server (to confirm status); Deploi uses the Accounting API.
- **Sandbox steps:** see docs/QUICKBOOKS-SETUP.md; then create an invoice, record a payment and send it in the sandbox
  company and check `invoice.changed` / `payment.changed` after the next poll.

## Buildium

- **Flow:** API key per customer (no OAuth). The customer creates the key in Buildium (Settings > Application
  settings > API settings; Buildium's API is available on its higher plans, to confirm) and pastes the client ID and
  secret on `/office/connections`. Deploi checks it with one read (`GET /v1/administration/account`) before storing.
  Headers: `x-buildium-client-id`, `x-buildium-client-secret`.
- **Redirect URIs:** none.
- **Env vars:** none required besides `CREDENTIALS_ENCRYPTION_KEY`; optional `BUILDIUM_ENVIRONMENT=sandbox`
  (`apisandbox.buildium.com`, shows "Sandbox only"), `BUILDIUM_ENABLED=off` to hide it.
- **Built:** properties (rentals), units, leases, lease tenants, applicants and rental applications (update status),
  work orders (list, read, create, update status by read-modify-PUT), resident (maintenance) requests (list, create);
  change polling (`lastupdatedfrom`) of work orders, leases, applications and requests; 429 backoff.
- **Revoke:** none by API: disconnect deletes the stored key; the customer deactivates the key in Buildium.
- **To confirm in the sandbox:** endpoint paths for applicants/applications and resident requests, the status values,
  and the `lastupdatedfrom` filter on each list (written from the public reference).
- **Sandbox steps:** request a Buildium sandbox (developer.buildium.com), create an API key with read/write on Rentals,
  Leasing, Applicants and Tasks, set `BUILDIUM_ENVIRONMENT=sandbox`, connect.

---

## Lead emails (Outlook)

Rules only (no model). `lib/leads/email-parsers.ts` recognises Zillow (`zillow.com`, `zillowrentals.com`,
`convo.zillow.com`), Apartments.com (`apartments.com`, `costar.com`) and Zumper (`zumper.com`) by sender domain and
subject, and falls back to a generic parser (a lead word plus a labelled contact field). Fields: name, email (or the
portal relay address, marked `replyVia: portal_relay`), phone (E.164), property, move-in date, message, source,
confidence. A lead from a sender that failed DKIM/DMARC is passed on with `senderVerified: false`. **The formats were
written from public examples and fixtures in `tests/fixtures/lead-emails`; confirm them with real notification emails
from each portal before launch.**
