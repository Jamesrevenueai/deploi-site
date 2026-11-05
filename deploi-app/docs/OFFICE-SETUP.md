# Deploi Office: setup

Deploi Office gives any business agents for HubSpot CRM, Google Calendar and email: Lead Follow-up,
Meeting Scheduler, CRM Updater and Customer Reply. They use the same permission, approval and audit model
as the store agents (`HOW-AGENTS-WORK.md`): every tool starts at **drafts only**; "after my approval" and
"without asking, within limits (at most one year)" are separate grants; every email, booking and CRM write
is one `office_actions` row with a unique idempotency key, confirmed by a fresh read and audited.

Office is enabled per organization (`org_products`, product `office`). A signed-in customer turns it on at
`/office`; that grants no agent anything.

## Status: not live-verified

Nothing in Office has been run against real HubSpot or Google accounts. Everything is tested against
synthetic providers and a fake HTTP layer. **Live verification is blocked** until the founder has:

1. a HubSpot developer account, a public app and a test portal (steps below);
2. a Google Cloud project with an OAuth client and the Calendar API enabled (steps below);
3. the four environment variables set on a preview deployment;
4. a mailbox for sending: either `AGENT_MAIL_DOMAIN` + `RESEND_API_KEY` + `AGENT_MAIL_WEBHOOK_SECRET`
   (Deploi Office mailbox), or a connected Gmail / Microsoft account (`EMAIL_OAUTH_PROVIDERS=on`);
5. `EMAIL_LIVE_SENDS=allowlist` with `EMAIL_TEST_RECIPIENTS` set to addresses you own.

Points to confirm during that first live run (each is marked in code as unverified behaviour):
HubSpot notes/tasks are writable with the contact scopes listed below; HubSpot search `CONTAINS_TOKEN`
finds the `deploi…` reference token in a note body; Google accepts `calendar.events.owned` for
`events.insert/patch/delete` and `calendar.freebusy` for `freeBusy.query` on the primary calendar.

## Environment variables

| Variable | Purpose |
|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot public app credentials. Without both, HubSpot shows "Needs setup" and `POST /api/office/connections {op:'connect'}` answers 503. |
| `HUBSPOT_REDIRECT_URL` | Optional; default `<APP_URL>/api/office/oauth/hubspot/callback`. |
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | Google OAuth client for Calendar (separate from the Gmail client `GOOGLE_OAUTH_CLIENT_*`, so Calendar can be verified on its own). |
| `GOOGLE_CALENDAR_REDIRECT_URL` | Optional; default `<APP_URL>/api/office/oauth/google/callback`. |
| `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID` | Already required: office tokens are AES-256-GCM encrypted with the same key, bound to their connection id. |
| `CRON_SECRET` | Already required: `/api/cron/office` (every 15 minutes) refuses calls without it. |
| `EMAIL_LIVE_SENDS`, `EMAIL_TEST_RECIPIENTS` | Office email goes through the existing email engine and this switch. |

Synthetic HubSpot, Calendar and mailbox connections are available on local and preview deployments (or with
`DEMO_CONTROLS=true`) and never on production. An agent can never combine synthetic and real accounts.

## 1. HubSpot app (founder steps)

1. Go to <https://developers.hubspot.com>, create (or sign in to) a developer account.
2. **Apps → Create app** (a public app, so any customer portal can install it). Name: "Deploi Office".
3. **Auth** tab:
   - Redirect URLs: `https://<preview-domain>/api/office/oauth/hubspot/callback` and, at launch,
     `https://app.getdeploi.com/api/office/oauth/hubspot/callback`. For local testing add
     `http://localhost:3000/api/office/oauth/hubspot/callback`.
   - Required scopes, exactly: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
     `crm.objects.deals.read`, `crm.objects.deals.write`. Notes and tasks are engagement objects associated
     with contacts and are written with the contact scopes (confirm in the first live run; if HubSpot
     requires an extra scope for your app type, add it here and to `HUBSPOT_SCOPES` in `lib/office/hubspot.ts`).
     Add no optional scopes.
4. Copy the **Client ID** and **Client secret** into `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` on the
   preview environment (never commit them).
5. **Test portals → Create a developer test account**, add two contacts with lifecycle stage **Lead** and
   email addresses you own (they must also be in `EMAIL_TEST_RECIPIENTS`).
6. HubSpot's OAuth flow takes no PKCE parameters; the one-time state (10 minutes, bound to organization and
   user) protects the callback. Access tokens last about 30 minutes; Deploi refreshes them 5 minutes before expiry.
7. Before listing the app in the HubSpot marketplace, HubSpot reviews it (app listing requirements, security
   questionnaire, a minimum number of active installs). Not needed for direct installs during early access.

## 2. Google Calendar OAuth client (founder steps)

1. <https://console.cloud.google.com> → create a project "Deploi Office" (or reuse the Deploi project).
2. **APIs & Services → Library → Google Calendar API → Enable.**
3. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External**; app name, support email, the Deploi logo, the privacy policy and terms URLs,
     authorized domain `getdeploi.com`.
   - Data access → add scopes, exactly:
     - `https://www.googleapis.com/auth/calendar.events.owned` — create, change and delete events on calendars
       the user owns. Narrower than `calendar.events` (which also covers calendars shared with the user) and much
       narrower than `calendar` (settings, sharing, every calendar).
     - `https://www.googleapis.com/auth/calendar.freebusy` — availability only (busy times), no event titles,
       descriptions or guests. Narrower than `calendar.readonly`, which would expose every event's details.
     - `openid`, `email` — to show which Google account is connected.
   - While in **Testing**, add your own Google accounts as test users (max 100; refresh tokens expire after 7 days).
4. **Clients → Create client → Web application.** Authorized redirect URIs:
   `https://<preview-domain>/api/office/oauth/google/callback`, `https://app.getdeploi.com/api/office/oauth/google/callback`
   and `http://localhost:3000/api/office/oauth/google/callback` for local testing.
5. Copy the client id and secret into `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`.
6. Deploi uses authorization code + PKCE (S256), `access_type=offline` and `prompt=consent` so a refresh token is
   issued. A user who unticks a box is refused at the callback with a clear message.

### Google verification for production

Both calendar scopes are **sensitive** (not restricted), so production needs Google's OAuth app
verification but **not** the CASA security assessment that restricted Gmail scopes need:

- Publish the app (Audience → **In production**) and submit for verification.
- Verified domain ownership of `getdeploi.com` in Google Search Console, homepage and privacy policy on that
  domain; the privacy policy must describe calendar data use (free/busy only; events created by Deploi) and
  Google's Limited Use requirements.
- A scope justification for each scope (use the bullet text above) and a demo video showing the consent
  screen, connecting at `/office/connections`, the agent proposing times and the booking appearing.
- Until verified: at most 100 users, an "unverified app" warning, and 7-day refresh tokens for test users.
- Typical review time: a few days to several weeks. Plan it before inviting customers.

## 3. Mailbox

Office agents send from one email account the customer chooses on `/office/connections`:

- **Deploi Office mailbox**: `<org>.<code>@AGENT_MAIL_DOMAIN`, sent through Resend; replies come back through
  the existing `email.received` webhook. Needs `AGENT_MAIL_DOMAIN`, `RESEND_API_KEY`, `AGENT_MAIL_WEBHOOK_SECRET`
  (see `EMAIL-SETUP.md`).
- **A connected Gmail or Microsoft 365 account** (Commerce → Connections, `EMAIL_OAUTH_PROVIDERS=on`), not
  live-verified either.

Every send passes the email engine's live-send switch: `EMAIL_LIVE_SENDS=off` holds them, `allowlist` sends only
to `EMAIL_TEST_RECIPIENTS`, `all` is production.

## 4. First live run (checklist)

1. Set the variables above on a preview deployment; `npm run db:migrate` there (migration `20261104000040_office.sql`).
2. Sign in, open `/office`, turn Office on, connect HubSpot (test portal), Google Calendar (test user), choose a mailbox.
3. Create **Lead Follow-up** (drafts only), grant, **Run now**: the draft shows the exact email to your test lead.
4. Change its email permission to "After my approval", grant the new version, run, approve in `/office/approvals`:
   check the email arrives once, a second approval is refused, and the work log shows "confirmed by a fresh read".
5. Reply "could we schedule a call?" from the lead's address; with a **Meeting Scheduler** (calendar after approval)
   check three proposed times respect your business hours and busy times; reply "2"; approve the booking; check the
   event exists once in Google Calendar with the lead as the only guest, and the confirmation email.
6. **CRM Updater** (CRM after approval): approve the notes; check they appear on the HubSpot contact once each.
7. Disconnect HubSpot and Calendar in Deploi; remove the app in HubSpot (Settings → Connected apps) and in Google
   (myaccount.google.com → Security → Third-party access).

## Where things live

`lib/office/*` (connections, clients, synthetic providers, policy, actions, runners, scheduler, approvals),
`app/office/*` (screens), `app/api/office/*` (API), `app/api/cron/office` (scheduler), `tests/office/*`.
`listOfficePendingApprovals(db, orgId)` and `decideOfficeAction(db, actor, actionId, 'approve' | 'reject')` in
`lib/office/approvals.ts` are the integration points for the unified approvals inbox (`db` = a service-role
connection; call `executeOfficeAction(id)` after an approval commits).

## Office on the Resolution Engine (cases)

Every lead, meeting request, CRM commitment and unanswered email an Office agent works on is a case
(`lib/cases`, suite `office`), shown through the generic case views (`/api/store/cases`). Code:
`lib/office/resolution.ts` (lead, meeting and CRM cases, handoffs, checkers), `lib/office/email-ops.ts`
(Email Operations), `lib/office/case-sync.ts` (moving a case along its records). Migration
`20261105000047_office_resolution.sql` only adds the `email_operations` agent kind.

| Kind | Dedupe (one open case per) | Resolved only when |
| --- | --- | --- |
| `lead_followup` | HubSpot contact | a meeting is read back from Google Calendar (not cancelled, lead as guest); or a "not interested" / opt-out reply is recorded and the CRM Updater's note is read back from HubSpot; or a fresh HubSpot read shows the opt-out (`hs_email_optout`) or a lifecycle change |
| `meeting_request` | HubSpot contact or email address | the booked event is read back from Google Calendar with the requester as guest |
| `crm_commitment` | HubSpot contact | the contact or deal is re-read from HubSpot with the new stage |
| `email_unanswered` | conversation | the requester's next reply acknowledges the answer; or no follow-up within `answeredAfterDays` after our accepted reply (recorded as "answered", not as confirmed); or the owner marks it handled with evidence |

Lifecycle: proposed (draft) → awaiting_approval → executing (send) → waiting_external (next check = the
follow-up cadence) → investigating (reply classified: interested / not interested / opt-out / question /
out-of-office, keyword rules) → scheduling (shown as proposed / waiting_external with "Scheduling:" reasons;
the engine has no separate status) → verifying → resolved. Sending never resolves a case.

Decisions:
- **Exhausted cadence** (all emails sent, reply window passed, no reply) → `escalated`, never `resolved`,
  never silently `cancelled`: a person decides; a late reply still moves the case.
- A **question** escalates to a person; an **out-of-office** (auto-reply flag or text) is recorded and the
  cadence continues; an **opt-out** stops the sequence and suppresses the address for the organization.
- **Handoffs** grant nothing: "interested" goes to the Meeting Scheduler, "not interested"/opt-out to the
  CRM Updater; each proposes under its own policy (a scheduler with calendar drafts only books nothing).
- **Organization stop**: open Office cases are blocked; runs and checks do nothing until it is cleared.
- Durable checks: `case.check` jobs run the registered checkers (`lib/cases/jobs.ts` imports them) with fresh
  reads of HubSpot and Google Calendar.

Email Operations (template "Email Operations", drafts only by default) reads accepted inbound mail on its
mailbox only (Deploi office mailbox or a synthetic one). Quarantined mail is never answered. Connected Gmail
and Outlook accounts give reply senders and times only; their inboxes are not read, so no case is opened
for them. Discovery detectors: `lib/discovery/detectors/office-crm.ts` (leads with no activity for 7+ days),
`office-email.ts` (messages unanswered for 4+ business hours); both register on import.

Not live-verified: all of the above runs against synthetic HubSpot, Calendar and mailbox only.
