# Email sending research: Gmail API and Microsoft Graph

Researched on 2026-10-28. The question is how Deploi can send email for a merchant from the merchant's own mailbox: Deploi drafts the message, the merchant approves it, and Deploi sends it.

**Method**

- Every claim links to an official page on developers.google.com, support.google.com or learn.microsoft.com, fetched on 2026-10-28.
- A few claims come from the providers' machine-readable discovery documents, which are also official: Google's OIDC discovery, the Gmail API discovery document and Microsoft's OIDC discovery.
- **UNVERIFIED** marks anything I could not confirm on an official page. Treat it as an assumption to test.

---

## 1. OAuth 2.0 for a server-side web app

### 1.1 Google

| Topic | Finding | Source |
|---|---|---|
| Authorization endpoint | `https://accounts.google.com/o/oauth2/v2/auth` (HTTPS only). | [web-server][g-ws]; [discovery][g-disc] |
| Token endpoint | `https://oauth2.googleapis.com/token` | [web-server][g-ws]; [discovery][g-disc] |
| PKCE | The discovery document lists `code_challenge_methods_supported: ["plain","S256"]`. The web-server guide does not mention PKCE. The installed-app guide documents `code_challenge` and `code_challenge_method`, with S256 recommended. Sending PKCE together with a client secret from a web-server client is **UNVERIFIED** in the web-server guide, though the discovery document suggests it works. | [discovery][g-disc]; [native-app guide][g-native] |
| Refresh token | Set `access_type=offline`: "the refresh token is only returned if your application set the `access_type` parameter to `offline`". Google issues it the first time the code is exchanged. `prompt=consent` forces the consent screen; without `prompt`, the user is prompted "only the first time your project requests access". To get a new refresh token, the user revokes the grant or you send `prompt=consent`. | [web-server][g-ws] |
| Refresh-token lifetime | No fixed lifetime. A refresh token stops working when any of these happens: the user revokes access; the token is unused for 6 months; the user changes password and the token has Gmail scopes; the per-account token limit is exceeded; time-based access expires; or an admin restricts the service (`admin_policy_enforced`). The limit is 100 refresh tokens per Google Account per OAuth client ID, and when it is exceeded the oldest token is invalidated "without warning". | [OAuth 2.0 overview][g-oauth2] |
| Testing-mode expiry | An External app in "Testing" status gets refresh tokens "expiring in 7 days", unless it only requests name, email, profile or openid. | [OAuth 2.0 overview][g-oauth2]; [App audience][g-audience] |
| Rotation | Google does not document rotation on refresh. **UNVERIFIED** whether a refresh ever returns a new refresh token. | — |
| Revoke | `POST https://oauth2.googleapis.com/revoke` with `token=` set to an access or refresh token. Revoking an access token also revokes its refresh token. Revocation removes all scopes granted to the project. Success is HTTP 200, an error is 400, and "it might take some time before the revocation has full effect". | [web-server][g-ws]; [discovery][g-disc] |
| Granted scopes in response | The token response field `scope` holds "The scopes of access granted by the access_token expressed as a list of space-delimited, case-sensitive strings." | [web-server][g-ws] |
| Granular consent | When several scopes are requested, "users may not grant your app access to all of them". The app must check `scope` and turn off features whose scopes were denied. `enable_granular_consent` only affects clients created before 2019. | [web-server][g-ws] |
| Incremental auth | `include_granted_scopes=true` means "the new access token will also cover any scopes to which the user previously granted the application access". | [web-server][g-ws] |
| Auth errors | Token exchange or refresh can return `invalid_grant` (expired or invalidated token, or a bad code). The fix is to send the user through consent again. A deleted OAuth client returns `deleted_client`. | [web-server][g-ws] |

### 1.2 Microsoft (Microsoft identity platform v2.0)

| Topic | Finding | Source |
|---|---|---|
| Authorization endpoint | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`. `{tenant}` is `common`, `organizations`, `consumers` or a tenant ID. | [auth code flow][m-authcode] |
| Token endpoint | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | [auth code flow][m-authcode] |
| PKCE | `code_challenge` is "now recommended for all application types, both public and confidential clients". Both `plain` and `S256` are supported, and S256 "SHOULD" be used. | [auth code flow][m-authcode] |
| Refresh token | The app must request the `offline_access` scope. The token response's `refresh_token` is "Only provided if offline_access scope was requested." | [auth code flow][m-authcode]; [scopes/OIDC][m-scopes] |
| Lifetime / rotation | The default refresh-token lifetime is 90 days, or 24 hours for SPAs. "Refresh tokens replace themselves with a fresh token upon every use." The old token is **not** revoked, so the app should store the new one and delete the old one. Microsoft can revoke refresh tokens at any time, for example on a password change or admin action (see the revocation table on the page). | [refresh tokens][m-refresh] |
| Revoke (what the app can do) | The OIDC discovery document has **no** `revocation_endpoint`, so there is no RFC 7009 revoke call. An app can delete its stored tokens. In a work or school tenant, a caller with `DelegatedPermissionGrant.ReadWrite.All` (an admin-level permission) can delete the `oAuth2PermissionGrant`. Existing access tokens then stay valid until they expire. `revokeSignInSessions` needs `User.RevokeSessions.All` and revokes **all** of the user's apps, so it is not a per-app revoke. Neither call works for personal accounts. | [discovery][m-disc]; [delete grant][m-grant-del]; [revokeSignInSessions][m-revoke] |
| Revoke (user) | Where a user removes app consent (My Apps, or the personal account privacy page) is **UNVERIFIED** on learn.microsoft.com. | — |
| Granted scopes in response | The token response `scope` is "The scopes that the access_token is valid for. Optional… if omitted, the token is for the scopes requested". | [auth code flow][m-authcode] |
| Incremental consent | With "incremental and dynamic user consent", newly requested scopes "will be granted in addition to any other permissions that were already granted". This applies to delegated permissions only. | [consent types][m-consent-dev] |
| `.default` | `.default` and individual scopes cannot be mixed in one request. | [scopes/OIDC][m-scopes] |
| Personal accounts | To accept work, school and personal accounts, register with signInAudience `AzureADandPersonalMicrosoftAccount` and use `/common`. | [supported accounts][m-accts]; [auth code flow][m-authcode] |
| Auth errors | Token endpoint `invalid_grant`: "The authorization code or PKCE code verifier is invalid or has expired." The token endpoint can also return `interaction_required`, `consent_required` and `temporarily_unavailable` (retry after a delay). | [auth code flow][m-authcode] |

---

## 2. Scopes and classification

### 2.1 Gmail scopes

| Scope | Purpose (Google wording) | Class | Source |
|---|---|---|---|
| `https://www.googleapis.com/auth/gmail.send` | "Send email on your behalf." | **Sensitive** | [Gmail scopes][g-scopes] |
| `https://www.googleapis.com/auth/gmail.compose` | "Manage drafts and send emails." | **Restricted** | [Gmail scopes][g-scopes]; [restricted list][g-restricted] |
| `https://www.googleapis.com/auth/gmail.readonly` | "View your email messages and settings." | **Restricted** | same |
| `https://www.googleapis.com/auth/gmail.metadata` | Labels and headers, "but not the email body". | **Restricted** | same |
| `https://www.googleapis.com/auth/gmail.modify` | Read, compose and send, but no permanent delete. | **Restricted** | same |
| `https://www.googleapis.com/auth/gmail.settings.basic` | Settings and filters. | **Restricted** | same |
| `https://mail.google.com/` | Full access, including IMAP, SMTP and POP. | **Restricted** | same |
| `openid`, `email`, `profile` | Identity only. These are exempt from the 7-day Testing expiry and from the test-user list. | Non-sensitive | [App audience][g-audience]; [OIDC][g-oidc] |

Google gives this advice for exactly our case: "If your app uses Gmail APIs to occasionally send emails on a user's behalf, don't request the scope that provides full access to the user's email data." ([restricted scope verification][g-rsv])

### 2.2 Google verification requirements

- **Brand verification** applies to every app that shows a name and logo. Requirements:
  - The homepage is on a verified domain the developer owns and describes the app (not just a login page).
  - The privacy policy is on the same domain, linked from the homepage and the consent screen, and discloses how Google user data is used.
  - Domains are verified in Search Console.
  - Brand verification typically takes 2–3 business days.

  Sources: [verification requirements][g-verif-req]; [restricted scope verification][g-rsv].
- **Sensitive-scope verification** (`gmail.send`) adds:
  - an appropriate use case;
  - a demo video of the full OAuth flow and every feature that uses the scope;
  - Limited Use compliance;
  - a written justification of why narrower scopes will not work.

  It "typically takes 3-5 business days". Sources: [verification requirements][g-verif-req]; [sensitive scope verification][g-ssv].
- **Restricted-scope verification** (`gmail.compose`, `gmail.readonly`, `gmail.metadata`, `gmail.modify`) adds:
  - an approved Gmail use case;
  - an **annual security assessment** if restricted data is stored on or passed through servers.

  Approved Gmail use cases include "Applications that enhance the email experience for productivity purposes (such as … customer relationship management…)". The process "can potentially take several weeks". Sources: [Gmail scopes][g-scopes]; [Workspace API policy][g-wspolicy]; [restricted scope verification][g-rsv].
- **Security assessment (CASA):**
  - It is annual and run by Google-approved third-party assessors under the CASA framework.
  - Apps are put in assurance level AL1 or AL2 based on user count, scopes and risk signals.
  - The assessor issues a Letter of Validation.
  - "Google does not charge the developer any fees for security assessment". The fee "is agreed on between the developer and the assessor". Some Tier 2 apps can self-scan for free.
  - **No dollar figure is stated on the official pages (UNVERIFIED).**

  Sources: [security assessment][g-assess]; [FAQ][g-faq].
- **Unverified-app user cap:** apps that show the unverified-app screen are limited to "100 new users in total". The cap applies "over the entire lifetime of the project" and "cannot be reset". Sources: [unverified apps][g-unverified]; [App audience][g-audience].
- **Testing mode:**
  - Testing allows "up to 100 test users".
  - Test users see a warning screen.
  - "Authorizations by a test user will expire seven days from the time of consent", including refresh tokens.
  - Testing projects are not subject to verification.

  Sources: [App audience][g-audience]; [when verification is not needed][g-exempt].
- **Internal apps** (users only in the developer's own Workspace organization) skip verification and the user cap. This does not help a public multi-tenant SaaS. Source: [when verification is not needed][g-exempt].
- **Workspace admins** can control which third-party apps may access their data, so a merchant on Workspace may need their admin to allow Deploi. Source: [App audience][g-audience].

### 2.3 Microsoft Graph delegated permissions

"Admin consent required" below is the default from the permissions reference. Tenant policy can make any of them admin-only (see 2.4).

| Permission | Meaning | Default admin consent (delegated) | Personal accounts | Source |
|---|---|---|---|---|
| `Mail.Send` | "Send mail as a user". It can save to Sent Items "even if the app isn't granted the Mail.ReadWrite" permission. | No | Yes | [permissions ref][m-perms] |
| `Mail.ReadWrite` | Create, read, update and delete mail. "Does not include permission to send mail." | No | Yes | [permissions ref][m-perms] |
| `Mail.Read` | Read the user's mailbox. | No | Yes | [permissions ref][m-perms] |
| `Mail.ReadBasic` | Read mail "except body, previewBody, attachments and any extended properties". | No | Yes | [permissions ref][m-perms] |
| `User.Read` | Sign in and read the user's profile. | No | Yes | [permissions ref][m-perms] |
| `offline_access`, `openid`, `email`, `profile` | OIDC scopes. `offline_access` "does not give the app any additional permissions". | No | Yes | [permissions ref][m-perms]; [scopes/OIDC][m-scopes] |

### 2.4 Microsoft tenant consent restrictions and publisher verification

- **User consent** is allowed by default for permissions that do not need admin consent. Microsoft recommends that admins allow user consent only for apps from **verified publishers**. Source: [configure user consent][m-user-consent].
- **Microsoft-managed default policy.** "Let Microsoft manage your consent settings" is "the default for a new tenant". Under it, end users can consent to delegated permissions **except** Graph `Mail.Read`, `Mail.ReadWrite`, `Mail.ReadBasic` (and their `.Shared` variants), `MailboxSettings.*`, `Calendars.*`, `Contacts.*` and others. `Mail.Send` is **not** on that exclusion list.
  - In such tenants, **reading mail and writing provider-side drafts need admin consent**, but `Mail.Send` does not.
  - A separate Microsoft-managed policy allows consent for a short list of named mail-client apps; Deploi is not on it.

  Source: [app consent policies][m-consent-pol].
- **Other built-in policies:**
  - `microsoft-user-default-low` allows consent "only for apps from verified publishers" (and apps registered in the tenant), and only for permissions the admin classifies as low impact.
  - `microsoft-user-default-legacy` allows any consent that does not need an admin.

  Source: [configure user consent][m-user-consent].
- **Publisher verification.** The current wording is: "Beginning November 2020, if risk-based step-up consent is enabled, users can't consent to most newly registered multitenant apps that aren't publisher verified." This applies to apps "registered after November 8, 2020" that request permissions beyond basic sign-in and profile, from users in other tenants. Requirements:
  - a verified Microsoft AI Cloud Partner Program (CPP) account, which must be the partner global account (PGA);
  - the app registered with a work or school account, in a tenant linked to that PGA;
  - a publisher domain that is not `*.onmicrosoft.com`;
  - MFA for the user who starts verification.

  "No charges are associated with completing the prerequisites". Source: [publisher verification][m-pubverif].
- **Personal accounts (outlook.com and similar)** use `/common` or `/consumers`. Whether personal-account consent is affected by publisher-verification status is **UNVERIFIED**.

---

## 3. Sending

### 3.1 Gmail

| Topic | Finding | Source |
|---|---|---|
| `users.messages.send` | `POST https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send` (metadata) or `POST https://gmail.googleapis.com/upload/gmail/v1/users/{userId}/messages/send` (media upload). It "Sends the specified message to the recipients in the To, Cc, and Bcc headers." | [messages.send][g-send] |
| Scopes accepted | `mail.google.com`, `gmail.modify`, `gmail.compose` or `gmail.send`. | [messages.send][g-send] |
| Body format | "MIME email messages compliant with RFC 2822 and encoded as base64URL strings" in the `raw` field. | [sending guide][g-sending] |
| Response | A `Message`. Its fields include `id` ("The immutable ID of the message"), `threadId` and `labelIds`. | [messages.send][g-send]; [Message resource][g-msg] |
| Threading a reply | Set `threadId`, set `References` and `In-Reply-To` per RFC 2822, and make the `Subject` match. | [Message resource][g-msg]; [sending guide][g-sending] |
| Size limit | The Gmail discovery document gives `mediaUpload.maxSize` = 36700160 bytes (35 MB) for `messages.send`, `drafts.create` and `drafts.send`, with accepted type `message/*`. Workspace sending limits allow 25 MB of attachments for most editions, measured before encoding. Where exactly the size check applies on the JSON `raw` path is **UNVERIFIED**. | [Gmail discovery][g-disc-gmail]; [uploads guide][g-upload]; [Workspace limits][g-wslimits] |
| Recipients | "there's also a limit of 500 recipients per email message" through the API. | [quota][g-quota] |
| Drafts | `drafts.create` creates a draft with the DRAFT label. `drafts.send` "Sends the specified, existing draft" and returns a `Message`. Both need `gmail.compose`, `gmail.modify` or `mail.google.com`, all of which are **restricted**. `gmail.send` cannot create drafts. | [drafts.create][g-dcreate]; [drafts.send][g-dsend] |
| Own Message-ID | Whether Gmail keeps a client-set `Message-ID` header in `raw` is **UNVERIFIED**. | — |

### 3.2 Microsoft Graph

| Topic | Finding | Source |
|---|---|---|
| `POST /me/sendMail` | Accepts JSON (`message` plus optional `saveToSentItems`, default true) or base64 MIME with `Content-Type: text/plain`. Needs `Mail.Send` (work, school or personal). Returns "202 Accepted" with no body. | [sendMail][m-sendmail] |
| What 202 means | "A 202 Accepted response code indicates that the request has been accepted; however, it doesn't indicate that the request processing has completed." The API creates the message in Drafts, then returns 202, and "Most of the steps (steps 2 to 7) take place after the method response is returned." | [sendMail][m-sendmail]; [send mail internals][m-things] |
| Draft then send | `POST /me/messages` creates a draft and needs `Mail.ReadWrite`. The response includes `id`, `internetMessageId` and `conversationId` (see the examples). `POST /me/messages/{id}/send` needs `Mail.Send`, takes `Content-Length: 0` and returns 202 with no body. | [create message][m-postmsg]; [message send][m-msgsend] |
| Custom headers | `internetMessageHeaders`: "Add custom headers only when creating a message, and name them starting with 'x-'. After the message is sent, you cannot modify the headers." Reading them back requires `$select`. The maximum number of custom headers is **UNVERIFIED**. Exchange limits all headers to 256 KB in total and 32 KB each. | [message resource][m-message]; [Exchange Online limits][m-exo] |
| Recipients | At most 500 across To, Cc and Bcc per message from an Exchange Online mailbox. | [message resource][m-message] |
| Attachments | `POST /messages/{id}/attachments` takes files "under 3 MB" and needs `Mail.ReadWrite`. Files from 3 to 150 MB need an upload session, which also needs `Mail.ReadWrite`. The request-size limit for inline attachments in a `sendMail` JSON body is **UNVERIFIED**. S/MIME payloads are limited to 4 MB (413). | [add attachment][m-att]; [large attachments][m-large]; [create message][m-postmsg] |
| Sending as an alias or another mailbox | Setting `from` to another mailbox needs `Mail.Send.Shared` plus Send As or Send on Behalf rights. This is not needed to send from the user's own mailbox. | [send from other user][m-sendas] |

---

## 4. Idempotency and reconciliation after a timeout

| Question | Answer | Source |
|---|---|---|
| Idempotency key, Gmail | None. `messages.send` takes only `userId` and the standard parameters; the discovery document has no request-ID parameter. | [Gmail discovery][g-disc-gmail]; [messages.send][g-send] |
| Idempotency key, Graph | None documented on `sendMail` or `send`. **UNVERIFIED** (absence of evidence). | [sendMail][m-sendmail] |
| Gmail: find a sent message with only `gmail.send`? | **No.** `messages.list`, `messages.get` and `threads.get` all need `gmail.readonly`, `gmail.metadata`, `gmail.modify` or `mail.google.com`. Even `getProfile` does not accept `gmail.send`. | [messages.list][g-list]; [messages.get][g-mget]; [getProfile][g-profile] |
| Gmail `rfc822msgid:` | The operator finds messages "with a specific message-id header". It is used in the `q` parameter of `messages.list`. `q` "cannot be used when accessing the api using the gmail.metadata scope", so the search needs `gmail.readonly` or `gmail.modify` (restricted). | [search operators][g-searchops]; [messages.list][g-list]; [filtering][g-filter] |
| Graph: find a sent message | `GET /me/mailFolders/sentitems/messages` lists Sent Items. The least-privileged permission is `Mail.ReadBasic`; `Mail.Read` or `Mail.ReadWrite` also work. `Mail.Send` alone cannot list. Filtering by `internetMessageId` is not shown in the official reference (**UNVERIFIED**; reported only in community Q&A). | [list messages][m-list]; [mailFolder][m-folder]; [message resource][m-message] |
| Graph draft-first pattern | `POST /me/messages` returns `id` and `internetMessageId` before sending, so the app has a key to reconcile against. Whether `internetMessageId` stays the same after `send` is **UNVERIFIED**. This pattern needs `Mail.ReadWrite`. | [create message][m-postmsg] |

---

## 5. Delivery evidence

- **Gmail:** "You can't assume that a 200 response means the email was successfully sent." After a user exceeds the sending quota, there "can be a delay of several minutes before the API begins returning 429". Source: [errors][g-errors].
- **Gmail bounces** arrive in the user's mailbox from "Mail Delivery Subsystem (mailer-daemon@googlemail.com)", often with the subject "Delivery Status Notification (Failure)". Reading them needs a restricted read scope. Source: [bounce help][g-bounce].
- **No delivery-receipt API in Gmail:** none is documented (**UNVERIFIED**, absence of evidence).
- **Graph bounces:** if transport fails, "the transport process constructs a non-delivery report message and places it in the sender's Inbox". Invalid recipients are detected after the 202, and "transport mails the non-delivery reports back to the sender". Source: [send mail internals][m-things].
- **Graph delivery and read receipts:** a delivery report is sent only "if the sender explicitly requested them", and read receipts may or may not be generated. The message property `isDeliveryReceiptRequested` is documented with the text "Indicates whether a read receipt is requested". Sources: [send mail internals][m-things]; [message resource][m-message].
- **Message trace** is admin-only:
  - In the admin center UI it needs Organization Management, Exchange Administrator or Global Administrator. It searches up to 90 days, 10 days per query.
  - The Graph API is `GET /admin/exchange/tracing/messageTraces`. It needs `ExchangeMessageTrace.Read.All` (admin consent required) and does not support personal accounts.

  Sources: [message trace UI][m-trace-ui]; [messageTraces API][m-trace-api]; [permissions ref][m-perms].
- **Strongest honest status after a successful call:**
  - Gmail 200 with `id`: "accepted by Gmail for sending".
  - Graph 202: "accepted by Exchange for processing".
  - Neither means delivered.
  - With read scopes, the only extra evidence is that the message appears in Sent (Graph moves it there after transport takes it) and no NDR arrives. That is still not proof of delivery.

---

## 6. Sending limits and throttling

| Provider | Limit | Source |
|---|---|---|
| Gmail API quota (projects created on or after 2026-05-01) | 1,200,000 units per minute per project and 6,000 units per minute per user per project. The daily billing threshold is 80,000,000 units per project. Projects that used the API between November 2025 and April 2026 keep their previous quotas. | [quota][g-quota] |
| Gmail cost per call | `messages.send` and `drafts.send` cost 100 units each. `drafts.create` costs 10, `messages.list` 5, `messages.get` 20 (60 for full or raw), `threads.get` 40 (120 for full) and `getProfile` 1. | [quota][g-quota] |
| Gmail per-user sending (Workspace) | 2,000 messages a day (500 on trial), measured over a rolling 24 hours. Also 10,000 total recipients a day, 3,000 external recipients a day, and 500 recipients per message through the Gmail API. Going over can block sending "for up to 24 hours". | [Workspace limits][g-wslimits] |
| Gmail per-user sending (consumer) | "more than 500 recipients in a single email and or more than 500 emails sent in a day" triggers the limit. Sending resumes "within 1 to 24 hours". | [Gmail limits][g-limits] |
| Gmail throttling errors | 429 can mean a daily sending limit ("User-rate limit exceeded (Mail sending)"), a bandwidth limit or a concurrency limit. 403 with `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded` or `domainPolicy` is also possible. Use truncated exponential backoff, and do not batch more than 50 requests. "You can't increase per-user limits." | [errors][g-errors]; [quota][g-quota] |
| Graph Outlook per app+mailbox | 10,000 API requests per 10 minutes, 4 concurrent requests, and 150 MB of upload per 5 minutes. | [throttling limits][m-tlimits] |
| Exchange Online per mailbox | Recipient rate of 10,000 recipients a day. Recipient limit of up to 1,000 per message (customizable; Graph caps it at 500). Message rate of 30 messages a minute. The tenant external recipient limit (TERRL) depends on licences and is 5,000 a day for trial tenants. | [Exchange Online limits][m-exo]; [message resource][m-message] |
| Outlook.com personal limits | **UNVERIFIED**; not on learn.microsoft.com. | — |
| Graph throttling | 429 with `Retry-After`. "Backing off requests using the Retry-After delay is the fastest way to recover." Retry 503 the same way, over a new connection. | [throttling][m-throttling]; [best practices][m-best] |

---

## 7. Error semantics for a status model

| Class | Gmail | Microsoft | Source |
|---|---|---|---|
| Auth expired or revoked | Token endpoint `invalid_grant`. API 401 `authError`: refresh the token, or re-consent if refresh fails. | Token endpoint `invalid_grant`, `interaction_required`. Graph 401 "authentication information is either missing or not valid". | [web-server][g-ws]; [errors][g-errors]; [auth code flow][m-authcode]; [Graph errors][m-errors] |
| Insufficient scope or policy | 401 `authError` can also mean "Missing authorization for the requested scopes". 403 `domainPolicy` means the Workspace domain blocks the app. | 403 "does not have enough permission"; `insufficient_claims` for Conditional Access. | [errors][g-errors]; [Graph errors][m-errors] |
| Bad request or recipient | 400 `badRequest` (missing or invalid field, invalid attachment). An unknown mailbox bounces later as an NDR. The exact error for a syntactically bad address is **UNVERIFIED**. | 400 for malformed requests or MIME ("Invalid base64 string for MIME content"). Invalid recipients are found after the 202 and come back as an NDR. | [errors][g-errors]; [sendMail][m-sendmail]; [send mail internals][m-things] |
| Quota or throttle | 429 or 403 `rateLimitExceeded` / `userRateLimitExceeded`. | 429 with `Retry-After`. | [errors][g-errors]; [throttling][m-throttling] |
| Too large | Over 35 MB on upload (**UNVERIFIED** status code). | 413 "request size exceeds the maximum limit". | [Gmail discovery][g-disc-gmail]; [Graph errors][m-errors] |
| Transient | 500 `backendError`, 502, 503, 504: retry with backoff. | 500, 503 (with `Retry-After`), 504. | [errors][g-errors]; [Graph errors][m-errors] |
| 5xx or timeout but actually sent? | Not documented either way (**UNVERIFIED**). Treat the outcome as unknown. A blind retry can send twice, because there is no idempotency key. | Step 1 (draft creation) "might fail… If the method fails, it returns a 4xx or 5xx". Whether a 5xx or timeout can come after step 1 succeeded is **UNVERIFIED**. Treat it as unknown. | [errors][g-errors]; [send mail internals][m-things] |

---

## 8. Reading replies (optional, separate permission)

- **Gmail:**
  - `threads.get` accepts `gmail.readonly`, `gmail.metadata`, `gmail.modify` or `mail.google.com`. All of them are restricted, so reading replies always means restricted-scope verification plus CASA.
  - With `gmail.metadata`, the `full` format "cannot be used". Only `metadata` (IDs, labels, headers) and `minimal` are allowed, so there are no bodies, and `q` search is not allowed.
  - The `threadId` returned by `messages.send` is the key for finding replies.

  Sources: [threads.get][g-tget]; [messages.list][g-list]; [threads guide][g-threads].
- **Graph:**
  - Every message has `conversationId`.
  - Listing messages needs at least `Mail.ReadBasic`, which gives no body, preview or attachments. Bodies need `Mail.Read`.
  - Under the Microsoft-managed default consent policy, users **cannot** self-consent to `Mail.ReadBasic` or `Mail.Read`, so admin consent is needed in such tenants.
  - Filtering on `conversationId` is not shown in the list reference (**UNVERIFIED**).

  Sources: [message resource][m-message]; [list messages][m-list]; [permissions ref][m-perms]; [app consent policies][m-consent-pol].

---

## 9. Identity of the connected sender

- **Google:**
  - Request `openid email`. The ID token then has `email` and `email_verified`. Use `sub` as the stable key: "Don't use the email field as a unique identifier".
  - The userinfo endpoint is `https://openidconnect.googleapis.com/v1/userinfo`.
  - With only `gmail.send`, `getProfile` (`emailAddress`) cannot be called, because it needs `gmail.compose` or a read scope.

  Sources: [OIDC][g-oidc]; [discovery][g-disc]; [getProfile][g-profile].
- **Gmail aliases:**
  - `settings.sendAs.list` returns "the primary send-as address… as well as any custom 'from' aliases". It needs `gmail.settings.basic`, `gmail.readonly`, `gmail.modify` or `mail.google.com`, all restricted.
  - What Gmail does with a `From` that is not a configured alias under `gmail.send` is **UNVERIFIED**.

  Sources: [sendAs.list][g-sendas]; [aliases guide][g-alias].
- **Microsoft:**
  - `GET /me` needs `User.Read` (work, school or personal).
  - `mail` is "The SMTP address for the user". `userPrincipalName` is the sign-in name, which "By convention… should map to the user's email name" but may differ, so display and send as `mail`.
  - The `email` OIDC claim "is included in a token only if an email address is associated with the user account, which isn't always the case".
  - Graph's userinfo endpoint is `https://graph.microsoft.com/oidc/userinfo`.
  - Sending from the user's own mailbox needs only `Mail.Send`. Send As or Send on Behalf matters only when `from` is another mailbox.

  Sources: [user get][m-userget]; [user resource][m-user]; [scopes/OIDC][m-scopes]; [discovery][m-disc]; [send from other user][m-sendas].

---

## 10. Implications for Deploi

**(a) Drafts kept in Deploi, approved messages sent through the provider (recommended baseline)**

- Google: `openid email gmail.send` with `access_type=offline`.
  - `gmail.send` is sensitive, so this needs brand verification plus sensitive-scope verification (about 3–5 business days), with **no CASA** assessment.
- Microsoft: `openid email profile offline_access User.Read Mail.Send`.
  - `Mail.Send` is user-consentable by default and is not excluded by the Microsoft-managed default consent policy.
- Status model:
  - `sent_accepted` after Gmail 200 + `id`/`threadId`, or Graph 202.
  - Never `delivered`.
  - On a timeout or 5xx, mark `send_unknown` and ask the merchant to check their Sent folder. Do **not** auto-retry, because neither API has an idempotency key and these scopes cannot look in Sent.
- Put a Deploi-generated `x-` header (Graph) or Message-ID (Gmail, **UNVERIFIED** that it is preserved) on each message, so a later read scope could reconcile it.

**(b) Optional drafts in the merchant's mailbox**

- Google needs `gmail.compose`, which is **restricted**: restricted-scope verification plus an annual CASA assessment, paid to the assessor.
- Microsoft needs `Mail.ReadWrite`. This is blocked from user consent in tenants on the Microsoft-managed default policy, so admin consent is needed there.
- The draft-first Graph flow (`POST /me/messages`, then `/send`) gives an `internetMessageId` before sending, which could support reconciliation.

**(c) Optional reply reading**

- Google needs `gmail.readonly` (or `gmail.metadata` for headers only, without search). Both are restricted, so CASA applies.
- Microsoft needs `Mail.ReadBasic` (no bodies) or `Mail.Read`. Both are excluded from user consent under the Microsoft-managed default policy, so admin consent is needed.

**What blocks a public launch**

- **Google:**
  - Production status needs verification, otherwise the unverified screen appears and the lifetime cap is 100 users.
  - Verification needs a verified domain, homepage, privacy policy, demo video and scope justification.
  - Any restricted scope ((b) or (c)) also needs the annual CASA assessment.
- **Microsoft:**
  - Publisher verification (a CPP partner global account and a custom verified publisher domain) is effectively required for a multi-tenant app requesting `Mail.Send`, because of risk-based step-up consent and the `microsoft-user-default-low` policy.
  - (b) and (c) also hit admin-consent requirements in many organizational tenants.

**What is possible today**

- **Google:** Testing mode with up to 100 named test users. They see a warning screen and their refresh tokens expire after 7 days, so re-consent weekly. Restricted scopes can be tried here too, without verification.
- **Microsoft:** a multi-tenant + personal app registration, tested in Deploi's own tenant (whose admin can consent to everything) and with personal outlook.com accounts. Whether unverified-publisher limits affect personal accounts is **UNVERIFIED**, so test it.

---

## Sources

[g-ws]: https://developers.google.com/identity/protocols/oauth2/web-server
[g-oauth2]: https://developers.google.com/identity/protocols/oauth2
[g-native]: https://developers.google.com/identity/protocols/oauth2/native-app
[g-disc]: https://accounts.google.com/.well-known/openid-configuration
[g-oidc]: https://developers.google.com/identity/openid-connect/openid-connect
[g-scopes]: https://developers.google.com/workspace/gmail/api/auth/scopes
[g-restricted]: https://support.google.com/cloud/answer/13464325
[g-verif-req]: https://support.google.com/cloud/answer/13464321
[g-assess]: https://support.google.com/cloud/answer/13465431
[g-faq]: https://support.google.com/cloud/answer/13463817
[g-unverified]: https://support.google.com/cloud/answer/7454865
[g-audience]: https://support.google.com/cloud/answer/15549945
[g-exempt]: https://support.google.com/cloud/answer/13464323
[g-rsv]: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
[g-ssv]: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
[g-wspolicy]: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
[g-send]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
[g-sending]: https://developers.google.com/workspace/gmail/api/guides/sending
[g-msg]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
[g-dcreate]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create
[g-dsend]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send
[g-upload]: https://developers.google.com/workspace/gmail/api/guides/uploads
[g-disc-gmail]: https://gmail.googleapis.com/$discovery/rest?version=v1
[g-quota]: https://developers.google.com/workspace/gmail/api/reference/quota
[g-errors]: https://developers.google.com/workspace/gmail/api/guides/handle-errors
[g-list]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
[g-mget]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
[g-tget]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
[g-threads]: https://developers.google.com/workspace/gmail/api/guides/threads
[g-profile]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
[g-sendas]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list
[g-alias]: https://developers.google.com/workspace/gmail/api/guides/alias_and_signature_settings
[g-filter]: https://developers.google.com/workspace/gmail/api/guides/filtering
[g-searchops]: https://support.google.com/mail/answer/7190
[g-wslimits]: https://support.google.com/a/answer/166852
[g-limits]: https://support.google.com/mail/answer/22839
[g-bounce]: https://support.google.com/mail/answer/6596
[m-authcode]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
[m-refresh]: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
[m-scopes]: https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
[m-consent-dev]: https://learn.microsoft.com/en-us/entra/identity-platform/consent-types-developer
[m-disc]: https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration
[m-revoke]: https://learn.microsoft.com/en-us/graph/api/user-revokesigninsessions
[m-grant-del]: https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-delete
[m-perms]: https://learn.microsoft.com/en-us/graph/permissions-reference
[m-user-consent]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
[m-consent-pol]: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies
[m-pubverif]: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
[m-accts]: https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation
[m-sendmail]: https://learn.microsoft.com/en-us/graph/api/user-sendmail
[m-things]: https://learn.microsoft.com/en-us/graph/outlook-things-to-know-about-send-mail
[m-postmsg]: https://learn.microsoft.com/en-us/graph/api/user-post-messages
[m-msgsend]: https://learn.microsoft.com/en-us/graph/api/message-send
[m-message]: https://learn.microsoft.com/en-us/graph/api/resources/message
[m-att]: https://learn.microsoft.com/en-us/graph/api/message-post-attachments
[m-large]: https://learn.microsoft.com/en-us/graph/outlook-large-attachments
[m-sendas]: https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user
[m-throttling]: https://learn.microsoft.com/en-us/graph/throttling
[m-tlimits]: https://learn.microsoft.com/en-us/graph/throttling-limits
[m-exo]: https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits
[m-errors]: https://learn.microsoft.com/en-us/graph/errors
[m-best]: https://learn.microsoft.com/en-us/graph/best-practices-concept
[m-userget]: https://learn.microsoft.com/en-us/graph/api/user-get
[m-user]: https://learn.microsoft.com/en-us/graph/api/resources/user
[m-list]: https://learn.microsoft.com/en-us/graph/api/user-list-messages
[m-folder]: https://learn.microsoft.com/en-us/graph/api/resources/mailfolder
[m-trace-ui]: https://learn.microsoft.com/en-us/exchange/monitoring/trace-an-email-message/message-trace-modern-eac
[m-trace-api]: https://learn.microsoft.com/en-us/graph/api/messagetracingroot-list-messagetraces
