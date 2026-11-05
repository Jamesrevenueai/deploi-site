# QuickBooks Online and the Accounts Receivable agent: setup

Deploi Office connects to **QuickBooks Online** (Intuit OAuth 2.0, Accounting API v3) and runs the
**Accounts Receivable** agent on it: it finds invoices that are past due, writes a reminder to the invoice's
own billing address with the invoice number, amount and due date exactly as QuickBooks shows them, follows up
on a cadence, and closes the case only when a fresh QuickBooks read shows the balance at zero.

The agent uses the same permission, approval and audit model as every Office agent (`OFFICE-SETUP.md`): the
template starts at **drafts only**; "after my approval" and "without asking, within limits (at most one
year)" are separate grants; every reminder is one `office_actions` row with a unique idempotency key and goes
through the existing email engine and its live-send switch.

## Status: not live-verified

Nothing here has been run against a real Intuit app or QuickBooks company. Everything is tested against a
synthetic QuickBooks (`lib/office/quickbooks-synthetic.ts`) and a fake HTTP layer. **Live verification is
blocked** until the founder has an Intuit developer app and a sandbox company (steps below). Points to confirm
in the first live run:

- the token endpoint answers the shapes in `lib/office/quickbooks.ts` (`access_token`, rotating `refresh_token`,
  `expires_in`, `x_refresh_token_expires_in`) and `invalid_grant` (HTTP 400) on a dead refresh token;
- the query `select * from Invoice where Balance > '0' STARTPOSITION n MAXRESULTS 100` pages as expected;
- a deleted invoice id answers 400 `ValidationFault` code `610` ("Object Not Found"), which is read as "gone";
- the webhook payload format your app receives (classic `eventNotifications` or the CloudEvents array; both are
  parsed) and the `intuit-signature` header;
- `minorversion=75` is accepted (set `QUICKBOOKS_MINOR_VERSION` if Intuit has moved on).

## What Deploi reads, and never does

- **Reads**: open invoices (number, dates, total, balance, currency, customer name, billing email, linked
  payments, private note), single payments and customers, and the company name. Scope:
  `com.intuit.quickbooks.accounting` only (no payments, no OpenID scopes).
- **Never writes to QuickBooks.** The accounting scope technically allows writes; Deploi's client has no
  write method (v1 reads only). Recording payments, voiding or sending QuickBooks' own reminders stay with the
  business.
- **Recipient**: only the invoice's `BillEmail`, as QuickBooks shows it when the reminder is sent (re-read just
  before sending). An invoice without a billing email is skipped and counted in discovery.
- **Values**: every amount, date and number in a reminder comes from a QuickBooks read. If the balance, billing
  email, number or due date changed since the reminder was drafted, that reminder is cancelled and a new one is
  prepared from the new read.
- **Resolved** only on a fresh read with balance 0 (the read, and the linked payments, are the evidence). A part
  payment keeps the case open with the new balance. Voided or deleted invoices close the case as cancelled.
- **Replies** are reduced to one category: dispute or anything unclear → reminders stop and the case is
  escalated to you; "we paid" → checked in QuickBooks now and daily, reminders wait a few days; a promise to
  pay with a date → no reminders until then and the next check on that date; unsubscribe → stop. Reply text
  never changes a recipient or a permission and is not copied into the case.
- **Exclusions**: customers listed in the agent's settings, and invoices whose QuickBooks *private note* says
  "disputed", "in dispute", "no reminders" or "do not chase".

## Environment variables

| Variable | Purpose |
|---|---|
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | The Intuit app's keys (Development keys for the sandbox, Production keys after Intuit's review). Without both, QuickBooks shows "Needs setup" and `POST /api/office/connections {op:'connect', provider:'quickbooks'}` answers **503 `needs_setup`**. |
| `QUICKBOOKS_REDIRECT_URL` | Optional; default `<APP_URL>/api/office/oauth/quickbooks/callback`. Must match a redirect URI in the Intuit app exactly. |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` reads `https://sandbox-quickbooks.api.intuit.com` (with Development keys); anything else reads production `https://quickbooks.api.intuit.com`. |
| `QUICKBOOKS_MINOR_VERSION` | Optional; default `75`. Sent as `minorversion` on every API call. |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | Optional. The app's webhook verifier token. Without it `POST /api/office/webhooks/quickbooks` refuses every delivery (503); payments are then noticed by the daily case check. |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID` | Already required: tokens are AES-256-GCM encrypted, bound to their connection id. |
| `EMAIL_LIVE_SENDS`, `EMAIL_TEST_RECIPIENTS` | Reminders go through the email engine and this switch. |

Approved outbound hosts (`lib/net/outbound.ts`, purpose `quickbooks`): `oauth.platform.intuit.com` (tokens),
`developer.api.intuit.com` (revoke), `quickbooks.api.intuit.com`, `sandbox-quickbooks.api.intuit.com`.
`appcenter.intuit.com` (consent) is a browser redirect, never fetched.

## 1. Intuit developer app (founder steps)

1. Go to <https://developer.intuit.com>, sign in or create an Intuit developer account.
2. **Dashboard → Create an app → QuickBooks Online and Payments**. Name it "Deploi Office".
   Choose the **Accounting** scope only (`com.intuit.quickbooks.accounting`).
3. **Keys & credentials → Development**: copy the Client ID and Client Secret into
   `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` on the preview environment (never commit them), and set
   `QUICKBOOKS_ENVIRONMENT=sandbox`.
4. **Redirect URIs** (Development and, later, Production), exactly:
   - `https://<preview-domain>/api/office/oauth/quickbooks/callback`
   - `https://app.getdeploi.com/api/office/oauth/quickbooks/callback` (at launch)
   - `http://localhost:3000/api/office/oauth/quickbooks/callback` (Development keys only; Intuit refuses
     `http` and `localhost` for Production).
5. **Sandbox company**: Dashboard → **Sandboxes → Add sandbox** (QuickBooks Online Plus, your country). Intuit
   pre-fills sample customers and invoices. Edit one or two invoices so that their **due date is more than 7
   days ago**, the **billing email** (Bill to → Email) is an address you own and is in `EMAIL_TEST_RECIPIENTS`.
6. **Webhooks** (optional): Development → Webhooks → endpoint
   `https://<preview-domain>/api/office/webhooks/quickbooks`, entities **Invoice** and **Payment**. Copy the
   **verifier token** into `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`.

Intuit's OAuth flow: Deploi sends the user to `https://appcenter.intuit.com/connect/oauth2` with a one-time
state (10 minutes, bound to organization and user); Intuit returns `code`, `state` and the chosen company's
`realmId` to the callback. The code is exchanged at the token endpoint with HTTP Basic client authentication;
Deploi then reads the company's name with the new token, which proves token and company belong together. The
connection is bound to that `realmId` for good (another company means disconnect and connect again). Access
tokens last one hour and are refreshed 5 minutes before expiry under a row lock; **refresh tokens rotate**
(each refresh returns the one to use next, which is stored) and expire after about 100 days without use; a
refused refresh marks the connection "needs reconnecting". Disconnect revokes the grant at Intuit
(`/v2/oauth2/tokens/revoke`) and deletes the stored tokens.

## 2. Production keys (Intuit's app assessment)

Production keys are issued only after Intuit's review:

- **Keys & credentials → Production**: complete the **app assessment questionnaire** (security and
  compliance: how tokens are stored, encryption at rest, data retention and deletion, incident response,
  hosting) and the app details (privacy policy and end-user licence URLs on `getdeploi.com`, host domain,
  launch URL, disconnect URL, support contact).
- Production redirect URIs must be `https`.
- Listing on the Intuit App Marketplace is a further, separate review; it is not needed for direct
  connections during early access.
- Typical review time: days to a few weeks. Then replace the Development keys with the Production keys and
  remove `QUICKBOOKS_ENVIRONMENT=sandbox`.

## 3. First live run (checklist)

1. Set the variables above on a preview deployment; run the migrations there (`20261105000048_quickbooks_receivables.sql`).
2. `/office` → turn Office on → `/office/connections` → **Connect QuickBooks Online** → pick the sandbox company.
   Confirm the connection shows the company's name.
3. Choose a mailbox (Office mailbox or a connected account). Create **Accounts Receivable** (drafts only), grant,
   **Run now**: one draft per overdue invoice, with the exact number, amount and due date; nothing is sent.
4. Widen email to "After my approval", grant, run, approve one reminder in `/office/approvals`; check it arrives
   at the billing address only.
5. In the sandbox, receive a part payment against the invoice: the next check adds the new balance to the
   case; the next reminder states it. Receive the rest: the case closes as **resolved** with the QuickBooks read
   as evidence.
6. Reply to a reminder with "we dispute this": the case is escalated to you and no further reminder is drafted.
7. Disconnect: the connection is revoked at Intuit (Intuit's "Connected apps" page no longer lists Deploi).
