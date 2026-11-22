# Subprocessor List

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft. Regions, transfer mechanisms and each provider's DPA must be confirmed against the
> actual accounts (project regions in Vercel and Supabase) before this list is published.

| Field | Value |
|---|---|
| Document key | `subprocessors` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

This list forms part of the Data Processing Addendum. It names the third parties Deploi uses to process
Customer Personal Data, taken from the systems the Service actually runs on (`deploi-app` code and
configuration as of 2026-11-04).

## A. Subprocessors engaged by Deploi

| Subprocessor | Purpose | Data processed | Location [CONFIRM] | Transfer mechanism [CONFIRM] |
|---|---|---|---|---|
| **Vercel Inc.** | Hosting of the web app, the embedded Shopify app, API routes and scheduled jobs; edge network | All data passing through requests; server logs (redacted) | United States (functions region [iad1?]); global edge | DPA + SCCs / DPF |
| **Supabase Inc.** | Postgres database (all Customer Data, encrypted tokens), authentication (sign-in e-mail links), backups | All stored Customer Data; account e-mails | [Project region, e.g. us-east-1] | DPA + SCCs |
| **Resend (Plus Five Five, Inc.)** | Sending agent e-mail and service e-mail; receiving mail for agent addresses | Recipient and sender addresses, subject, body and attachments of messages | United States | DPA + SCCs |
| **Stripe, Inc.** (and Stripe Payments Europe, Ltd. for EEA customers) | Subscription billing for customers not billed through Shopify; customer portal | Billing contact name and e-mail, organization id, payment details (entered on Stripe, never stored by Deploi) | United States / Ireland | Stripe DPA + SCCs / DPF |

[If an AI model provider is enabled to generate drafts, add it here before enabling it, with its
no-training terms — see REVIEW-CHECKLIST S-3. No model provider is called in the current build.]

## B. Platforms the Customer connects (Customer-instructed)

These are the Customer's own accounts. Deploi reads from and writes to them only as the Customer's
granted Authorizations instruct. Each platform processes the data under the Customer's own agreement
with it.

| Platform | When used | What Deploi exchanges with it |
|---|---|---|
| **Shopify Inc.** (Shopify Admin API, Partner API, Shopify billing) | Deploi Commerce on Shopify; App Store billing | Products, inventory, publications; orders and customers only under protected-customer-data scopes when those agents are on; subscription status |
| **WooCommerce stores** (the merchant's own WordPress host, via the WooCommerce REST API) | Deploi Commerce on WooCommerce | Products, inventory and, when those agents are on, orders and customers |
| **HubSpot, Inc.** | Deploi Office CRM agents | Contacts, companies, deals, tasks, notes in the objects authorized |
| **Google LLC** (Google Workspace, Gmail, Google Calendar; Google sign-in for mailbox connection) | Deploi Office calendar and e-mail agents; mailbox connection | Calendar availability and events; agent-sent messages and replies, only when read access is granted |
| **Microsoft Corporation** (Microsoft 365 / Outlook), when enabled | Mailbox connection (not live-verified yet) | As for Google |

## C. Not used

- No analytics, advertising, session-replay or tracking providers on the website or in the app.
- The website loads the Inter typeface from Google Fonts (the browser requests it directly from Google;
  see the Cookie Notice).

## Changes

New Subprocessors are added to this list at least [30] days before they process Customer Personal Data
(see DPA section 3.3). Subscribe to notices by e-mailing `privacy@getdeploi.com` [CONFIRM].

| Date | Change |
|---|---|
| 2026-11-04 | First draft |
