# Email connector: setup, permissions, provider approval and testing

Sources: `docs/platform-research/email.md` (official Google and Microsoft documentation; unconfirmed points marked UNVERIFIED).

## What exists today

| Provider | Implemented | Locally tested | Live verified | Externally blocked by |
|---|---|---|---|---|
| Synthetic mailbox | yes | yes (every engine path, fault injection) | n/a (sends nothing) | nothing |
| Gmail / Google Workspace | yes (OAuth + PKCE, identity, send, revoke; reply tracking with read access) | request shapes and outcome mapping against a fake HTTP layer | **no** | an OAuth client, test users, then Google brand and sensitive-scope verification for public use; restricted-scope verification plus an annual security assessment (CASA) for reading replies |
| Microsoft 365 / Outlook | yes (OAuth + PKCE, identity, send) | request shapes and outcome mapping against a fake HTTP layer | **no** | an app registration; publisher verification for a public multi-tenant app; admin consent for reading in most organizations. Reply tracking and Sent-folder lookup are disabled until verified on a test tenant |

## Environment

Names only; values come from the provider consoles and must never be committed.

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` (default `common`: work, school and personal accounts)
- `EMAIL_OAUTH_REDIRECT_URL`: defaults to `<app url>/api/email/oauth/callback`. Register exactly this URL with both providers.
- `CREDENTIALS_ENCRYPTION_KEY` / `CREDENTIALS_KEY_ID`: the same keys that protect store tokens. They also encrypt mailbox tokens and message content.
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
