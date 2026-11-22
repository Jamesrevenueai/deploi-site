# Security Overview

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft, written for customers' security questionnaires. Every statement must stay true of the
> code; the engineering evidence for each is listed so it can be re-checked before publication. Open
> findings are tracked in `docs/SECURITY-REVIEW-2026-11-04.md`.

| Field | Value |
|---|---|
| Document key | `security` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

## 1. Architecture

Deploi is a Next.js application hosted on Vercel, with a Postgres database and authentication on
Supabase. The embedded Shopify app runs in the Shopify admin and calls the same server. E-mail is sent and
received through Resend. Subscriptions are billed through Shopify (App Store installs) or Stripe.

## 2. Customer isolation

- Every table holding customer data has **Postgres row-level security**. A signed-in user's queries run
  as the database role `authenticated` with their identity, and the database itself returns only their
  organization's rows. Deploi staff have a separate, read-only view for support.
- Writes go through server functions that check the caller's organization first, then use a privileged
  role.
- *Evidence*: `tests/security/rls-coverage.test.ts` enumerates every table and fails if any lacks RLS or a
  scoped policy; `tests/security/tenant-isolation.test.ts` seeds a row for a second organization in every
  organization-scoped table and checks the first organization reads none of them.

## 3. Authentication

- Sign-in with a one-time link sent by e-mail; no passwords are stored.
- In the Shopify admin, each request carries a short-lived session token signed by Shopify, verified on
  the server with the app secret.
- State-changing requests from the web app must come from the app's own origin (CSRF check).
- Production refuses development sign-in at three layers: the build fails, the server will not start,
  and the runtime ignores development cookies (`lib/auth-guard.ts`, `tests/security/production-auth.test.ts`).
- New users cannot choose their own role or organization: only invites and server-set metadata assign
  them, and staff status is an exact e-mail match (migration `20261104000042`).

## 4. Encryption

- TLS for all traffic; HSTS with a two-year max-age.
- Store and mailbox access tokens: AES-256-GCM at the application layer, key held in the hosting
  environment, not in the database; never sent to the browser. Credential tables have no grant to any
  user role (`tests/security/credentials.test.ts`).
- Agent e-mail content: encrypted at rest.
- Database storage and backups: encrypted at rest by Supabase.

## 5. Agents: least privilege by design

- Every tool starts at **drafts only**. Higher levels need an explicit grant of an exact, numbered rule
  set; widening needs a new grant.
- The rules are checked at the moment of each write or send; the record is re-read before writing and
  verified afterwards; daily and per-run caps and a loop guard limit damage; pause, revoke and delete
  cancel queued work.
- Content (product text, files, e-mail) is data and cannot change an agent's rules.
- An incident switch (`LIVE_WRITES=off`) pauses writes to every real store at once; real e-mail sending
  is off by default per environment (`EMAIL_LIVE_SENDS`).

## 6. Inbound and outbound traffic

- Webhooks are verified by signature with constant-time comparison: Shopify (HMAC-SHA256), Resend
  (svix), Stripe (`Stripe-Signature`, 5-minute tolerance, replay-deduplicated by event id).
  Scheduled jobs require a bearer secret.
- Every outbound request is checked against an approved host list for its purpose; private network
  addresses are refused (`lib/net/outbound.ts`, `tests/security/outbound.test.ts`).
- Browser hardening: `X-Frame-Options: DENY` and `frame-ancestors 'none'` everywhere except the embedded
  app, which may be framed only by `admin.shopify.com` and the requesting shop; `nosniff`;
  strict referrer policy; a restrictive `Permissions-Policy`.

## 7. Logging and audit

- Inserts, updates and deletes are recorded by database trigger; agents keep a work log of every run,
  proposal, approval, change, message and verification.
- Legal acceptances are append-only evidence (who, which exact text by SHA-256, when, IP, browser).
- Logs redact person-identifying keys and never contain tokens or message content (`lib/log.ts`).

## 8. Secure development

- Code review on every change before merge; protected production deploys.
- Automated tests, including the security tests above, a repository secret scan
  (`tests/security/secrets.test.ts`), an API route sweep that checks every merchant route resolves the
  organization from the session and every webhook verifies a signature (`tests/security/routes.test.ts`).
- Separate preview and production environments; previews protected by the hosting provider.

## 9. Data deletion

Disconnecting a store or uninstalling the Shopify app deletes its access token; Shopify's `shop/redact`
request deletes the store's data. See the Privacy Policy and Data Processing Addendum.

## 10. Reporting a vulnerability

E-mail `security@getdeploi.com` [CONFIRM]. Please do not test against other customers' data. We will
acknowledge within [2] business days.

## 11. What we do not claim

Deploi does not currently hold a SOC 2, ISO 27001 or PCI DSS certification of its own [UPDATE IF THIS
CHANGES]; it relies on its providers' certifications for hosting, database and payments. Card data is
handled entirely by Stripe or Shopify.
