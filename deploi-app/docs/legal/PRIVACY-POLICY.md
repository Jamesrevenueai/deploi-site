# Privacy Policy

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft for legal review. It describes how the Service is built today (2026-11-04) so counsel
> can check it against the law; it is not yet a public notice. The public site currently shows an older
> privacy text (`src/pages/Legal.tsx`) that states the app reads no customer or order data; that is no
> longer true once order and customer agents are enabled (see `REVIEW-CHECKLIST.md`, item P-1).

| Field | Value |
|---|---|
| Document key | `privacy` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

This policy explains what personal information **[COMPANY LEGAL NAME]** d/b/a Deploi AI ("Deploi",
"we") collects, why, who we share it with, how long we keep it and the choices you have. It covers the
website `getdeploi.com`, the web app `app.getdeploi.com`, and the Deploi app embedded in the Shopify admin.

There are two roles to keep apart:

- For **your account** (the people at your business who sign in) and for **our website**, Deploi decides
  why and how the data is used: we are the **controller** (or "business" under US state laws).
- For the data inside your **Connected Accounts** (your store's customers and orders, your CRM contacts,
  your mailbox), you decide what the agents do: you are the controller and Deploi is your **processor**
  ("service provider"). The **Data Processing Addendum** governs that processing; this policy only
  describes it so you can inform the people concerned.

## 1. Information we collect

### 1.1 Account and sign-in
- Name, work e-mail address, organization name, role (owner or member) and the products you use.
- Sign-in is by a one-time e-mail link (Supabase Auth). We do not store passwords.
- For people who use the app from the Shopify admin: the Shopify staff user ID and shop domain from the
  session token Shopify issues. We do not receive Shopify passwords.

### 1.2 Legal acceptance and billing
- When you accept these documents we record the document, its version and a fingerprint (SHA-256) of the
  exact text, the time, your user ID and e-mail, your IP address and your browser's user-agent string,
  as evidence of the agreement.
- Billing through Stripe: we store the Stripe customer and subscription identifiers, plan, status and
  renewal dates. Card details are entered on Stripe's own page and never reach our servers. Billing
  through Shopify: we store the plan and status Shopify reports.

### 1.3 What agents read from Connected Accounts (processor data)
Only what the agents you switch on need, under the permissions (scopes) you grant on each platform:

| Source | Data | Used by |
|---|---|---|
| Shopify / WooCommerce store | products, variants, prices, SKUs, inventory levels and locations, sales-channel publications, shop name, domain, timezone and currency | Inventory Watcher, Store Health Checker, Listing Writer and other store agents |
| Shopify / WooCommerce store (only when an order or customer agent is switched on and the "protected customer data" scopes are granted) | orders, fulfilments, returns, and the customer's name, e-mail, shipping address and messages needed for the task | Order Tracker, Customer Care, Returns, Payout & Fees Checker |
| Shopify payouts and fees (when switched on) | payout amounts, fees and dates | Payout & Fees Checker |
| HubSpot (Deploi Office) | contacts, companies, deals, tasks and notes in the objects you authorize | Office lead follow-up agents |
| Google Workspace / Gmail / Google Calendar, Microsoft 365 (when connected) | calendar events and free/busy; in a mailbox, only the messages an agent sends and the replies to them, if you grant read access for that task | Office and e-mail agents |
| Files you upload | price lists, SKU mappings, publication lists | the agent that the file is attached to |
| Public competitor websites you list | public product pages, prices and availability as shown | Competitor & Trend Watcher (no personal data) |

### 1.4 Agent e-mail
An agent can have its own address on our domain. Messages it sends and mail sent to it are stored
**encrypted at rest** with sender, recipients, subject and body so you can read them in Deploi. Mail from
senders outside the agent's allowed list, or that fails sender checks, is quarantined. Incoming mail
never changes what an agent may do.

### 1.5 Activity and audit records
What each agent found, proposed, changed or sent, which authorization allowed it, who approved it,
and the verification result; sign-in and access events; support conversations.

### 1.6 Website
Only what you type into the early-access form (name, work e-mail, company, store URL, platforms, rough
catalogue size, the problem you describe). The website has no analytics, advertising pixels or session
replay. See the Cookie Notice.

### 1.7 Technical data
IP address, browser type and request metadata in server logs. Logs are filtered to remove access tokens,
passwords, message content and personal fields before they are written, and are kept up to 30 days.

## 2. How we use information

- To provide the Service: run the agents you configure, show evidence, make the changes and send the
  messages you authorized, verify the result and keep the work log.
- To secure the Service: authenticate users, isolate organizations, detect abuse, investigate incidents.
- To bill you and enforce plan limits.
- To support you and to tell you about changes to the Service or these documents.
- To keep evidence of agreements and to meet legal obligations.

We do **not** sell or "share" (for cross-context behavioural advertising) personal information, do not
use processor data for our own marketing, and do not use Customer Data to train generally available AI
models.

**Legal bases (EEA/UK).** Contract (providing the Service to your business), legitimate interests
(security, fraud prevention, product improvement with aggregated data, B2B communication), legal
obligation (tax, records), and consent where required (for example optional e-mail updates).

## 3. Who we share it with

Only with the subprocessors listed in the **Subprocessor List** (hosting: Vercel; database and sign-in:
Supabase; e-mail delivery: Resend; payments: Stripe; and the platforms you connect, such as Shopify,
WooCommerce stores, HubSpot and Google), each under written terms; with professional advisers under
confidentiality; where the law requires; or in a merger or acquisition, under the same protections.

## 4. International transfers

Our providers process data in the United States and other countries. Where EEA, UK or Swiss law
requires it we rely on the EU Standard Contractual Clauses, the UK Addendum, or the provider's
certification under the EU-US Data Privacy Framework (and its UK and Swiss extensions). [COUNSEL: confirm
per provider.]

## 5. Retention

| Data | Kept |
|---|---|
| Account and organization | while the account is active, then deleted within [90] days |
| Store, CRM and mailbox data read by agents | while the connection is active; deleted when you disconnect, or for Shopify on receipt of `shop/redact` (sent by Shopify 48 hours after uninstall) |
| Work log and audit trail | while the account is active (deleted with the store data above) |
| Access tokens | encrypted at rest; deleted on disconnect or uninstall |
| Legal acceptance records | for the life of the account plus [6] years, as evidence of the agreement [COUNSEL] |
| Billing records | as long as tax law requires ([7] years) |
| Server logs | up to 30 days |
| Early-access applications | until reviewed and [12] months after the last contact |

## 6. Your choices and rights

You can see, correct, export or delete the information we hold about you by e-mailing
`privacy@getdeploi.com` [CONFIRM ADDRESS]. Depending on where you live you may also have the right to
object to or restrict processing, to data portability, to withdraw consent, and to complain to a data
protection authority. California residents have the rights in the CCPA/CPRA, including to know, delete,
correct and opt out of sale or sharing (we do neither), and we will not discriminate against you for
exercising them. We verify requests before acting on them and respond within the time the law requires.

If you are a **customer of one of our merchants** (for example a shopper or a CRM contact), please
contact that business first; we process your data on their behalf and will help them answer.

## 7. Security

Organizations are isolated in the database by row-level security; access tokens and message content are
encrypted at rest; webhooks are verified by signature; changes are audited. See the Security Overview.

## 8. Children

The Service is for businesses and is not directed to children under 16. We do not knowingly collect
their information.

## 9. Changes

We will post a new version with a new version number and date. If the change is material we will notify
account owners and, where the Service requires acceptance, ask you to accept the new text.

## 10. Contact

[COMPANY LEGAL NAME], [POSTAL ADDRESS], Ohio, USA — `privacy@getdeploi.com`. [EU/UK representative under
GDPR Art. 27 / UK GDPR, if required: COUNSEL.]
