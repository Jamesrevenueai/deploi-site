# Email connector: setup, permissions, provider approval and testing

Sources: `docs/platform-research/email.md` (official Google and Microsoft documentation; unconfirmed points marked UNVERIFIED).

## Recommended path: agent mailboxes on Deploi's domain (no Google or Microsoft approval needed)

Each agent can have its own address, `<name>.<code>@AGENT_MAIL_DOMAIN`. It sends from that address through Resend, and suppliers reply to it. Merchants forward or copy threads to it. This path needs **no Gmail restricted scopes and no provider review**. Setup and DNS (SPF, DKIM, DMARC, MX and the inbound webhook) are in `docs/LAUNCH-DNS.md` §B.

| Piece | Where | Tested |
|---|---|---|
| Mailbox per agent (unique address across organizations; used only by its own agent) | `lib/email/mailbox.ts` | `tests/merchant/platform.test.ts` |
| Send via Resend with `Idempotency-Key = deploi-<message id>`, tagged Reply-To for threading | `lib/email/adapters/deploi.ts` | fake Resend: a repeat or a forced re-queue sends once |
| Strict recipient allowlist (even an approved message cannot go to anyone outside it) | `lib/email/check.ts` | refused-with-approval test |
| Inbound (`email.received`): signed webhook, delivery dedupe, threading by token then headers, sender allowlist, SPF/DKIM/DMARC quarantine, encrypted storage, audit | `app/api/webhooks/agent-mail`, `lib/email/inbound.ts` | threading, duplicates, quarantine, retry, and webhook-refusal tests |
| Customer inbox (threads, read/unread, label with an agent, reply as a person through `sendMessage` and every gate) | `lib/email/inbox.ts`, `/store/inbox/mail` | `tests/infra/email.test.ts` |
| Suppression: Resend `email.bounced` / `email.complained` and one-click unsubscribe (`List-Unsubscribe` + `List-Unsubscribe-Post`, signed link, `/api/webhooks/agent-mail/unsubscribe`) block later sends to that address, per organization | `lib/email/suppression.ts`, `lib/email/unsubscribe.ts` | `tests/infra/email.test.ts` |
| Per-organization daily cap (`EMAIL_ORG_DAILY_CAP`), loop protection (auto-replies never count as replies), attachments stored as metadata only | `lib/email/engine.ts`, `lib/email/loop.ts` | `tests/infra/email.test.ts` |
| Supplier follow-up: one reply in the same thread when the supplier has not answered | `lib/email/tasks.ts#supplierFollowup` | unit + run |
| **Live verified** | — | **No.** Needs `AGENT_MAIL_DOMAIN`, Resend domain verification and your dedicated test address (`LAUNCH-DNS.md` §B4). |

**Live steps still to do (founder):** in Resend, verify `AGENT_MAIL_DOMAIN`; add one webhook to `https://<app>/api/webhooks/agent-mail` subscribed to `email.received`, `email.bounced`, `email.complained` and `email.delivered`, and put its signing secret in `AGENT_MAIL_WEBHOOK_SECRET`; set `RESEND_API_KEY`, `EMAIL_LIVE_SENDS=allowlist` with your own test address in `EMAIL_TEST_RECIPIENTS`; then send one approved message, reply to it, click its unsubscribe link and confirm the address shows as suppressed. Not done in this build: there is no key or domain here.

Resend facts used (from resend.com/docs, 2026-10-28):
- the `email.received` webhook carries metadata only; the text and headers come from `GET /emails/receiving/{id}`;
- `Idempotency-Key` is kept for 24 hours.

**Not confirmed in Resend's docs:** that custom `In-Reply-To`/`References` headers are honoured. They are set, but threading relies on the tagged Reply-To address.

## New senders on the Deploi office mailbox (first contact)

Before 2026-11-06 any sender the agent had never written to was quarantined and never answered. Now, on the organization's **office mailbox** (Email Operations), a first-contact message is accepted when **all** of these hold (`lib/email/sender-policy.ts`), and otherwise it is quarantined with a reason code the inbox shows:

| Check | Source | Quarantine code |
|---|---|---|
| SPF, DKIM **and** DMARC all `pass` | Resend `GET /emails/receiving/{id}` → `authentication.{spf,dkim,dmarc}`, each `pass`, `fail`, `gray`, `processing_failed` or `unknown`; `null` for mail received before Resend added the field. Anything but `pass`, or a missing field, fails closed. Gmail / Outlook: the receiving server's own top `Authentication-Results` header (`mx.google.com` for Gmail). | `auth_unverified` (`auth_failed` for an explicit `fail`, for any sender) |
| Not bulk or list mail | `Precedence: bulk/list/junk`, `List-Id`, `List-Unsubscribe`, bulk-mailer `X-Mailer` | `bulk` |
| Not automatic | `Auto-Submitted` (RFC 3834), auto-responder headers, automatic sender addresses and subjects (`lib/email/loop.ts`) | `automated` |
| Not suppressed | bounced, complained or unsubscribed for this organization | `suppressed` |
| Under the rate | `EMAIL_FIRST_CONTACT_SENDER_DAILY` (default 3) per sender and mailbox, `EMAIL_FIRST_CONTACT_MAILBOX_DAILY` (default 50) per mailbox, in 24 hours | `rate_sender`, `rate_mailbox` |
| Not blocked | the owner's blocklist (an address or `@domain`) | `blocked` |

- Known senders (the organization's people, any address the organization wrote to, a sender whose first reply the owner approved, the agent's recipient rules) are accepted as before; only an explicit authentication `fail` or the blocklist quarantines them.
- An accepted first-contact message is marked `first_contact`. **The reply to it always waits for an individual approval by an owner or admin, whatever the agent's tier** (drafts-only agents keep it a draft). That approval trusts the sender; later replies follow the tier. The send gate checks it again before every send.
- The owner (or an admin) can **release** a quarantined message from the inbox (`POST /api/store/inbox/inbound/{id}/release`) and **block** a sender (`POST /api/store/inbox/senders`). Blocked and suppressed senders cannot be released. A released new sender stays first contact.
- Store agents' own mailboxes (Supplier Coordinator and others) keep their allowed list: unknown senders there are quarantined (`not_allowed`).
- Message content never takes part in these decisions and can never change recipients, tiers or tools (tested: `tests/office/inbox-reading.test.ts`).

## Inbox reading for Email Operations (Gmail and Outlook)

Off unless the owner turns on **Read my inbox** in an Email Operations agent's permission (a widening that needs a grant), and then allows reading on the connected account. The explanation is shown before the provider's consent screen (`lib/office/mailbox.ts#INBOX_READ_EXPLANATION`). Only then does the connect flow ask for `gmail.readonly` or `Mail.Read` (`email_oauth_states.want_inbox`).

| | Gmail (`lib/email/readers/gmail.ts`) | Outlook / Microsoft 365 (`lib/email/readers/microsoft.ts`) |
|---|---|---|
| Scope | `https://www.googleapis.com/auth/gmail.readonly` (restricted) | `Mail.Read` + `offline_access` (admin consent in most organizations) |
| Incremental | `users.history.list?startHistoryId=…&historyTypes=messageAdded`, every page | `GET /me/mailFolders/inbox/messages/delta`, every `@odata.nextLink`, stored `@odata.deltaLink` |
| Expired cursor | 404 → `users.getProfile` (new historyId first) + `messages.list?q=newer_than:7d in:inbox -category:promotions` (bounded) | 410 Gone → a new round with `$filter=receivedDateTime ge <7 days ago>` |
| Fetch | `messages.get?format=metadata`, then `format=full` only for inbox mail (not spam, trash, drafts, promotions) up to 2 MB; larger: headers only | `GET /me/messages/{id}` with selected fields, `internetMessageHeaders`, attachment metadata only (`$expand=attachments($select=name,contentType,size)`), text body (`Prefer: outlook.body-content-type="text"`) |
| Owner replied outside Deploi | `in:sent` / `SENT` messages mark earlier mail in that thread as answered | Sent Items delta (`conversationId`, `sentDateTime`) |
| Reply from Deploi | `messages.send` with `threadId`, `In-Reply-To` / `References`, `Re:` subject | `POST /me/messages/{id}/reply` (needs only `Mail.Send`; recipients set explicitly). With `Mail.ReadWrite` granted: `createReply` → `PATCH` → `send` |
| Errors | 401 / missing scope → account **needs reconnection**; 429 / quota → back off (`Retry-After`, else exponential up to 1 hour); 5xx → back off | same |
| Optional push | `users.watch` on INBOX → Pub/Sub push to `/api/webhooks/gmail-push` (OIDC token verified) | subscription on `me/mailFolders('inbox')/messages` → `/api/webhooks/graph-mail` (validation handshake; `clientState` checked against a stored hash) |

Polling (the agent's hourly run) is the default; push only triggers the same sync sooner. Messages are stored once per account (provider id and Message-ID), encrypted, with attachments as metadata only. Text is capped at 100,000 characters. Health for the reconnection UI: `lib/email/inbox-sync.ts#inboxSyncHealth` (`email_sync_state`).

### Google: what is needed for `gmail.readonly` (external, owner)

1. Google Cloud project with the **Gmail API** enabled; OAuth consent screen (Google Auth Platform) with the app name, logo, support email, the homepage and privacy policy on a domain you verified in Search Console.
2. Data access: add `gmail.send` and `gmail.readonly` with a justification for each (Email Operations reads new inbox mail to find unanswered customer messages and drafts replies the owner approves).
3. Until verified: **Testing** status, up to 100 named test users, refresh tokens expire after 7 days, an unverified-app warning.
4. **Brand verification**, then **restricted-scope verification** for `gmail.readonly`:
   - a demo video of the whole OAuth flow and every feature that uses the scope;
   - the privacy policy must disclose the Gmail data use and state compliance with the *Google API Services User Data Policy, including the Limited Use requirements*;
   - an approved use case (productivity / CRM-style email apps qualify) and a written reason narrower scopes do not work (`gmail.metadata` has no bodies and no search).
5. **CASA security assessment**: annual, by a Google-authorized third-party assessor (Cloud Application Security Assessment, tier set by Google), ending in a Letter of Validation submitted to Google; the fee is agreed with the assessor. Re-verification is required every 12 months.
6. Google Workspace customers: their administrator may need to allow Deploi under *Security → API controls → App access control*.
7. Optional push: a Pub/Sub topic; grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it; a push subscription to `https://<app>/api/webhooks/gmail-push` **with authentication** (a service account and an audience). Set `GMAIL_PUSH_TOPIC=projects/<p>/topics/<t>`, `GMAIL_PUSH_AUDIENCE=<audience>`, `GMAIL_PUSH_SERVICE_ACCOUNT=<service account email>`.

### Microsoft: what is needed for `Mail.Read` (external, owner)

1. Microsoft Entra admin center → App registrations → New: *Accounts in any organizational directory and personal Microsoft accounts*; Web redirect URI `EMAIL_OAUTH_REDIRECT_URL`; a client secret (`MICROSOFT_OAUTH_CLIENT_SECRET`).
2. API permissions (Microsoft Graph, **delegated**): `openid`, `email`, `profile`, `offline_access`, `User.Read`, `Mail.Send`, `Mail.Read`. Deploi does not need `Mail.ReadWrite`.
3. **Admin consent**: `Mail.Read` cannot be user-consented in tenants on the Microsoft-managed default policy. Each customer's administrator grants it once, in Enterprise applications → Deploi → Permissions → *Grant admin consent*, or through `https://login.microsoftonline.com/<tenant>/v2.0/adminconsent?client_id=<id>&scope=https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send&redirect_uri=<redirect>`.
4. **Publisher verification** (a Microsoft AI Cloud Partner Program account and a custom publisher domain) so other tenants can consent at all under risk-based step-up consent.
5. Optional change notifications: `EMAIL_GRAPH_PUSH=on` (and `EMAIL_GRAPH_PUSH_URL` if the public URL differs from `APP_URL`). The URL must be public HTTPS and answer the validation request within 10 seconds (the route does).

**Live verified:** no. Everything above is tested against fake HTTP layers that follow the documented shapes (`tests/unit/inbox-readers.test.ts`, `tests/office/inbox-reading.test.ts`). Still to check on real accounts: that Gmail's `Authentication-Results` and Exchange Online's are the top header in the API's header order; the Graph `$filter` on the first delta round; `/reply` with an explicit `message.toRecipients`.

## Gmail and Microsoft 365: kept in the code, off by default, not live-verified

They appear in Connections only when `EMAIL_OAUTH_PROVIDERS=on` **and** their OAuth clients are configured. Their labels say "(not live-verified)".

## What exists today

| Provider | Implemented | Locally tested | Live verified | Externally blocked by |
|---|---|---|---|---|
| Agent mailbox (Deploi domain) | yes | yes (fake Resend, inbound fixtures) | **no** | DNS and Resend domain verification; your test address |
| Synthetic mailbox | yes | yes (every engine path, fault injection) | n/a (sends nothing) | nothing |
| Gmail / Google Workspace | yes (OAuth + PKCE, identity, send, revoke; reply tracking with read access) | request shapes and outcome mapping against a fake HTTP layer | **no** | an OAuth client, test users, then Google brand and sensitive-scope verification for public use; restricted-scope verification plus an annual security assessment (CASA) for reading replies |
| Microsoft 365 / Outlook | yes (OAuth + PKCE, identity, send) | request shapes and outcome mapping against a fake HTTP layer | **no** | an app registration; publisher verification for a public multi-tenant app; admin consent for reading in most organizations. Reply tracking and Sent-folder lookup are disabled until verified on a test tenant |

## Environment

Names only; values come from the provider consoles and must never be committed.

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` (default `common`: work, school and personal accounts)
- `EMAIL_OAUTH_REDIRECT_URL`: defaults to `<app url>/api/email/oauth/callback`. Register exactly this URL with both providers.
- `CREDENTIALS_ENCRYPTION_KEY` / `CREDENTIALS_KEY_ID`: the same keys that protect store tokens. They also encrypt mailbox tokens and message content.
- `EMAIL_OAUTH_PROVIDERS`: `on` to offer Gmail and Microsoft (off by default; not live-verified).
- `EMAIL_FIRST_CONTACT_SENDER_DAILY` (3), `EMAIL_FIRST_CONTACT_MAILBOX_DAILY` (50): first-contact rates.
- `GMAIL_PUSH_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`: optional Gmail push (all three, or none).
- `EMAIL_GRAPH_PUSH=on`, optional `EMAIL_GRAPH_PUSH_URL`: optional Graph change notifications.
- `AGENT_MAIL_DOMAIN`, `RESEND_API_KEY`, `AGENT_MAIL_WEBHOOK_SECRET`: agent mailboxes (see above).
- `EMAIL_LIVE_SENDS`:
  - `off` (default): no real provider send.
  - `allowlist`: only to `EMAIL_TEST_RECIPIENTS`, a comma-separated list of addresses or `@domains`.
  - `all`: production only, after review.
- `CRON_SECRET`: the hourly `/api/cron/agents` run also retries rate-limited messages and re-checks interrupted or unknown sends.

## Permissions requested

| Purpose | Google | Microsoft |
|---|---|---|
| Sign-in identity | `openid email profile` | `openid email profile offline_access User.Read` |
| Send (drafts live in Deploi) | `gmail.send` (sensitive) | `Mail.Send` (user-consentable) |
| Read replies and look up sent mail (only when an agent's task needs it) | `gmail.readonly` (**restricted**) | `Mail.ReadBasic` (**admin consent** in most organizations) |
| Read the inbox for Email Operations (only when the owner turns on "Read my inbox") | `gmail.readonly` (**restricted**: verification + CASA) | `Mail.Read` (**admin consent** in most organizations) |

Deploi does not request `gmail.compose` or `Mail.ReadWrite`. Drafts are kept in Deploi and shown in full for review, so no restricted scope is needed for drafting.

## What a successful send means

- **Gmail:** a `200` from `messages.send` (with an `id`) and **Microsoft:** a `202` from `sendMail` both mean *accepted for delivery*, not delivered. Deploi shows **Accepted by provider** and never "Delivered". Bounces arrive in the merchant's mailbox.
- **Uncertain outcomes:** a timeout, lost connection or 5xx shows as **Delivery unknown**. Neither API has an idempotency key.
  - **Synthetic accounts:** Deploi looks the message up and resends at most once, only after two checks at least five minutes apart show it is absent.
  - **Gmail with read access:** a match on `rfc822msgid:` marks it accepted. A miss is not treated as proof, because it is UNVERIFIED that Gmail keeps our Message-ID.
  - **Microsoft:** no lookup yet. The merchant checks their Sent folder and answers *It was sent* or *It was not sent: send it*.

## Live verification (to do, with controlled accounts only)

1. **Google:**
   1. Create a Cloud project with the OAuth consent screen in *Testing*, and add test users (max 100). Refresh tokens expire after 7 days in Testing.
   2. Create a Web client with the redirect URL above, and set the env vars.
   3. Set `EMAIL_LIVE_SENDS=allowlist` and `EMAIL_TEST_RECIPIENTS` to addresses you control.
2. **Microsoft:**
   1. Register a multi-tenant + personal-account app.
   2. Add the redirect URL and a client secret, and add the delegated permissions `Mail.Send` and `User.Read` (and `Mail.ReadBasic` for reply tests).
   3. Test in your own tenant and with a personal outlook.com account.
3. **For each provider:**
   1. Connect from Connections.
   2. Create a review-mode agent that emails only your test recipients, and approve a message.
   3. Confirm it arrives and that Deploi shows **Accepted by provider**.
   4. Then try authorized mode with a one-day end date.
   5. Disconnect, and confirm queued messages show **Cancelled**.
4. **Record** in `docs/platform-research/email.md`:
   - Whether Gmail keeps the Message-ID Deploi sets.
   - Whether Graph accepts `internetMessageId` on `sendMail` and supports filtering Sent Items by it.
   - Whether Graph allows filtering by `conversationId`.
   - What a 5xx on send actually did.

## Provider approval for public launch (external)

- **Google:**
  - Production publishing status needs brand verification: a verified domain, homepage, privacy policy, demo video and scope justification.
  - `gmail.send` needs sensitive-scope verification (typically a few business days).
  - Reading replies (`gmail.readonly`) needs restricted-scope verification plus an annual third-party security assessment, paid by Deploi.
  - Until verified, an app shows an unverified-app screen and is limited to 100 users for its lifetime.
- **Microsoft:**
  - Publisher verification (a verified Microsoft partner account and a custom publisher domain) so users can consent to a multi-tenant app.
  - Reading needs admin consent in organizations on the default consent policy.

## Reply threading: the Resend header question (resolved for our side, 2026-10-28)

**Question:** Resend's docs do not say that custom `In-Reply-To` and `References` headers survive a send. If they are dropped, would supplier replies still attach to the right message?

**Answer: yes. Threading does not depend on those headers.** Each sent message has its own Reply-To address, `<mailbox>+t-<token>@<agent domain>`, and an inbound reply is matched by that token first. The `In-Reply-To` and `References` headers are only a fallback.

Tested with synthetic inbound mail, no network (`tests/merchant/mail-threading.test.ts`, 7 tests, all passing):

| Synthetic inbound | Result |
|---|---|
| Sent to the tagged Reply-To, with **no** `In-Reply-To` and **no** `References` (as if Resend dropped them) | Threaded to the right message, accepted |
| Sent to the plain address, with `In-Reply-To` only (a client that replies to From) | Threaded |
| Neither token nor headers | Kept as unthreaded; never attached to a guessed message; the reply count stays 0 |
| Another organization's token on this mailbox | Not threaded: no cross-organization match |

**Still unverified (needs a live send to a test mailbox):** whether Resend and the receiving mail client keep the plus-tag in the Reply-To address. Most do: the address is ordinary RFC 5322 and Resend passes `reply_to` as given. If a client strips it, the reply falls back to header matching, then to "unthreaded", and the merchant still sees it in the mailbox. Check it once with step B4 in `LAUNCH-DNS.md`.
