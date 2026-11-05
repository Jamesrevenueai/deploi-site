# Security review — 2026-11-04

Scope: `deploi-app` on branch `claude/ws-f` (database schema and grants, RLS, API routes, webhooks,
headers, secrets, the new legal and billing code). Method: catalog queries against a freshly migrated
database, code reading, and the automated tests listed below, which now run in every `npx vitest run`.
Nothing in production was read or changed.

Severity: **Critical** (cross-tenant or privilege compromise reachable by an outsider), **High**,
**Medium**, **Low**, **Info**. Status: **Fixed** (in this branch, with a test), **Open** (needs an owner).

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | Critical | `leads` view bypassed RLS: any signed-in user could read every early-access application | Fixed |
| F-02 | Critical | Sign-up metadata chose the new user's role and organization (self-service staff / join any org) | Fixed |
| F-03 | High | Staff e-mail list matched by substring (`hello@getdeploi.co` became staff) and was callable by anon | Fixed |
| F-04 | High | `TRUNCATE` (not subject to RLS) granted to `anon`/`authenticated` on most tables | Fixed |
| F-05 | Medium | `_migrations` had no RLS and was writable by user roles | Fixed |
| F-06 | Medium | No script/style Content-Security-Policy (only `frame-ancestors`) | Fixed (script policy, enforced; styles not restricted) |
| F-07 | Medium | Shopify `customers/redact` and `customers/data_request` answer "no customer data held"; untrue once order/customer agents or agent e-mail hold shopper data | Fixed locally 2026-11-06: data requests export, erasures delete or anonymize (`lib/privacy`, `tests/privacy`) |
| F-08 | Medium | Any member of an organization (or any Shopify admin user of the store) can grant agent authorizations; no owner-only role | Fixed (2026-11-05) |
| F-09 | Medium | With billing on, `/api/store/plan` would let a merchant switch to any tier for free | Fixed |
| F-10 | Low | Monthly agent-action allowance is shown but not enforced at run time | Fixed |
| F-11 | Low | A downgrade arriving by Stripe webhook updates the tier but does not switch off library agents the new tier excludes (the merchant-initiated path does) | Fixed |
| F-12 | Low | No rate limit on the public early-access form or on sign-in link requests (beyond Supabase's own) | Fixed |
| F-13 | Info | Dev sign-in on production (`AUTH_MODE=dev`, `ALLOW_DEV_LOGIN=true`) per `PRODUCTION-SAFETY.md` §2 | Open (owner action, not re-verified here) |
| F-14 | Info | `email_messages.reply_token` is readable by the owning organization | Accepted |

## Details

### F-01 Critical — `leads` view bypassed RLS (Fixed)
`create view leads as select * from prospects …` (foundation migration) runs with its owner's rights.
Default privileges granted `SELECT` on it to `authenticated`. A merchant session (or anyone holding a
Supabase session through PostgREST) could `select * from leads` and read every early-access applicant's
name, e-mail, phone and notes, although `prospects` itself is staff-only. Verified on the test database
before the fix (an authenticated session read the row; `prospects` returned 0).
Fix (migration 42): `security_invoker = true` on the view and `revoke all … from anon, authenticated`.
The view is unused by code. Test: `tests/security/credentials.test.ts`, and
`tests/security/rls-coverage.test.ts` now fails on any view that bypasses RLS for user roles.

### F-02 Critical — sign-up chose its own role and organization (Fixed)
`handle_new_user()` read `raw_user_meta_data.role` and `.agency_id`. On Supabase that object is set by
the person signing up (`signUp`/`signInWithOtp` `data`, callable with the public anon key), so anyone
could create a staff account (read every organization) or join any organization by id. `lib/auth.ts`
had the same trust in `user_metadata` in its fallback path.
Fix: the trigger and the fallback read only `raw_app_meta_data` / `app_metadata` (writable only with the
service role key) and invites. Test: `credentials.test.ts` inserts a user with
`{role:'staff', agency_id:<other org>}` metadata and gets a plain client with no organization.
**Owner action:** check production `profiles` for staff or organization memberships not created by an
invite or by staff (`select id, email, role, agency_id, created_at from profiles where role = 'staff'`);
also consider disabling open sign-ups in Supabase Auth while the beta is invite-only.

### F-03 High — staff e-mail substring match; list exposed (Fixed)
`position(lower(new.email) in staff_email_list()) > 0` made any address that is a substring of the
comma-joined list staff, e.g. `hello@getdeploi.co` (a registrable domain) or `lo@getdeploi.com`. The
function was executable by `anon`, disclosing the staff list. Fix: exact match against the split list;
`revoke execute … from public, anon, authenticated`. Tested.

### F-04 High — TRUNCATE granted to user roles (Fixed)
Default privileges (`grant all on tables to anon, authenticated`) left `TRUNCATE`, `TRIGGER` and
`REFERENCES` on most tables, including `agencies`, `profiles` and `org_products` (`org_products` also had
`INSERT/UPDATE/DELETE` for `anon`). Row-level security does not apply to `TRUNCATE`. PostgREST does not
expose it, so exploitation needed another SQL path, but it is one mistake away. Fix: revoked on every
public table and from the default privileges. Test fails if any such grant reappears.

### F-05 Medium — migration ledger open (Fixed)
`_migrations` (created by `scripts/migrate.ts`) had no RLS and full grants for `authenticated`. Fix: RLS
on, all user-role privileges revoked (the runner connects as the owner). Allowlisted as deny-all.

### F-06 Medium — no script CSP (Fixed for scripts)
**Fix.** `middleware.ts` now sends, on every page, a per-response nonce policy built by `lib/security/csp.ts`:
`script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `https://cdn.shopify.com` on `/shopify/*` as the
CSP2 fallback), `object-src 'none'`, `base-uri 'self'`, `connect-src 'self'` + the Supabase project origin
(and Shopify hosts on `/shopify/*`), and the unchanged `frame-ancestors`. The nonce reaches the renderer in
the request's `Content-Security-Policy` header (Next.js puts it on all of its scripts) and in `x-nonce`
(the root layout puts it on the App Bridge script; `lib/shopify/head.ts` keeps it when moving App Bridge
first). The embedded document's second render pass makes its own nonce and the document keeps exactly
that pass's policy. A client-sent `x-nonce` / CSP request header is overwritten. Every route renders
dynamically (the root layout reads headers), so no prerendered page lacks the nonce. Production needs no
`'unsafe-eval'`: the only `Function(...)` uses in the client bundles are `globalThis` fallbacks never
reached by current browsers; `next dev` gets `'unsafe-eval'` and `ws:` (dev only). **Mode: enforced**, since
the full Playwright suite passes under it, including a new test that loads `/login` and `/store`, checks
every script tag carries the response nonce and records zero CSP violations. `CSP_MODE=report-only` moves
the script policy to `Content-Security-Policy-Report-Only` (frame-ancestors stays enforced, since browsers
ignore it in report-only policies); `CSP_REPORT_URI` adds a report endpoint. **Still open:** the embedded
app was verified only with the App Bridge stub (the three embedded e2e tests need Shopify credentials);
check `/shopify` once inside a real Shopify admin after deploy, and switch to `CSP_MODE=report-only` if
App Bridge reports violations. Styles (`style-src`) are not restricted. Tests:
`tests/security/headers.test.ts` (policy on `/login`, `/store`, `/shopify`, nonce forwarded to the
renderer, no smuggled nonce, no unsafe-eval in production, report-only split), `e2e/security.spec.ts`.

Original finding: `middleware.ts` set only `frame-ancestors`. A nonce-based `script-src` (Next.js supports nonces via
middleware) plus `object-src 'none'; base-uri 'self'` would limit XSS impact. Not added here because the
embedded app's App Bridge script, the App Bridge head re-ordering and Next's inline scripts must be
tested together in the Shopify admin; a wrong policy breaks the embedded app. Owner: shared-infra.
Added now: `Permissions-Policy` and `X-Permitted-Cross-Domain-Policies` (`next.config.ts`), tested in
`tests/security/headers.test.ts`.

### F-07 Medium — Shopify privacy webhooks vs. stored shopper data (Open)
`lib/connectors/shopify/webhooks.ts` answers `customers/data_request` and `customers/redact` with "no
customer data is stored". Order Tracker, Customer Care, Returns and agent e-mail (drafts and replies in
`email_messages`, `library_actions`) can hold shopper names, e-mails and messages. Before those agents run
on a real store, the handlers must export/erase those rows, and the public privacy text must change
(`docs/legal/REVIEW-CHECKLIST.md` P-1). Owner: Shopify workstream.

### F-08 Medium — no owner-only grants (Fixed 2026-11-05)
Was: every signed-in member and every Shopify admin user of the store could grant and widen agents.
Now (migration 20261105000051, `lib/platform/rbac.ts`): each person has an organization role, owner / admin /
member / viewer, read from the database at the moment of each decision. Only owners and admins grant a policy
version (engine `grantPolicy`, Office `grantOfficePolicy`), resume an agent, switch a library agent on, widen a
library or Build-your-own permission, grant auto-run, change the plan, use billing checkout and portal, and
connect or disconnect accounts (Office, mailboxes, WooCommerce). Approving an individual item (engine proposals
and retries, email messages, Office actions, library drafts, the unified approvals inbox) needs an owner or
admin, or a member when the owner allows it (`agencies.members_can_approve`, default off). Viewers are read-only:
`resolveActor` refuses every state-changing call. Rejecting, pausing and stopping stay open to members (they only
reduce what agents do). Existing organizations kept their behaviour: the oldest member became the owner and every
other member an admin. Embedded Shopify admin sessions act as admin (the session token does not say whether the
user is the shop owner), so owner-only actions (deleting the organization, owner changes, the approval policy)
need a signed-in owner in the Deploi web app. Tested in `tests/platform/rbac.test.ts`.

### F-09 Medium — free tier switch with billing on (Fixed)
`POST /api/store/plan` sets `agencies.plan_tier` (which decides which library agents can be switched on)
without payment. Harmless in the free beta; with `BILLING_MODE` on it would bypass payment. The route
now refuses while billing is on (one line); the tier follows the Stripe subscription
(`lib/billing/webhooks.ts`). Tested in `tests/billing/stripe-flow.test.ts`.

### F-10, F-11 Low (Fixed)
- F-10 (fixed): `lib/plans/allowance.ts` counts carried-out agent actions per UTC calendar month (agent
  store writes executing/applied/verified/unknown, agent email sending/accepted/delivery_unknown, Office
  actions executing/succeeded/unknown, library writes done; never drafts, proposals, refused, blocked,
  stale, cancelled or failed attempts). While `BILLING_MODE` is on, `authorizeAgentAction` (store and
  email), the store write's last gate, Office's execution claim and the library runner hold work at the
  allowance under a per-organization lock: a store write goes back to "waiting for your approval" (its
  approval withdrawn), an email or Office action waits for approval, a library auto-run write stays a
  draft and approving one answers `allowance_exhausted`. Individually approved items are held too.
  Usage is in the Control Room (`usage`) and on the billing page. Tests: `tests/plans/enforcement.test.ts`.
- F-11 (fixed): `lib/plans/enforce.ts` runs after every processed Stripe event (same transaction) and
  hourly for subscriptions not in good standing: library agents the applicable tier excludes are switched
  off (`switchOffExcluded`, shared with `setTier`, no merchant actor needed), the most recently created
  active engine agents beyond `maxAgents` and Office agents beyond `officeSeats` are paused, each audited,
  plus one `plan.enforced` entry. A lapse (cancelled, unpaid, paused, past due beyond grace) applies the
  lowest tier. Nothing is deleted; an upgrade resumes nothing; resume and first grant refuse beyond the
  plan. Office connections are checked at connect.

### F-12 Low — rate limits (Fixed)
Postgres-backed limiter (`lib/security/rate-limit.ts`, migration 44 `rate_limits`, RLS on with no policy,
functions executable by `service_role` only): one atomic `INSERT … ON CONFLICT DO UPDATE` per check, sliding
window estimate over two fixed windows, expired windows cleaned opportunistically. Answers 429 with
`Retry-After`. Configurable with `RATE_LIMIT_<BUCKET>=<limit>/<seconds>`; `RATE_LIMITS=off` disables all.
Every bucket fails open if the database is down (the guarded request needs that database anyway).
Client IP = first `x-forwarded-for` hop, else `x-real-ip`: trustworthy on Vercel, which overwrites both;
behind another proxy only as trustworthy as that proxy. IPv6 is keyed by /64.

| Bucket | Default | Where |
|---|---|---|
| `lead` | 6 / 10 min per IP | `/api/public/lead` |
| `magic_link_ip`, `magic_link_email` | 10 / 15 min per IP; 5 / h per address | `magicLink` (`app/login/actions.ts`) |
| `dev_login` | 300 / 10 min per IP | `devSignIn` (dev auth only) |
| `auth_callback` | 30 / 10 min per IP | `/auth/callback` |
| `oauth_start` | 30 / 10 min | `/api/shopify/auth/start` (per IP); mailbox, Office and WooCommerce consent starts (per organization) |
| `oauth_callback` | 60 / 10 min per IP | Shopify, Office (Google, HubSpot) and mailbox OAuth callbacks |
| `unsubscribe` | 30 / 10 min per IP | `POST /api/webhooks/agent-mail/unsubscribe` |
| `woo_callback` | 30 / 10 min per IP | `/api/woocommerce/callback` |
| `merchant_write` | 600 / min per organization (staff: per user) | `resolveActor(req, { mutating: true })` |
| `webhook_invalid` | 120 / 10 min per IP | Shopify, WooCommerce, agent mail and Stripe webhooks: only deliveries that fail signature verification are counted; valid deliveries are never counted or refused |

Sign-in refusals redirect to `/login?error=too-many-attempts`. The e2e suite runs under the defaults (one IP,
~60 dev sign-ins, at most ~35 writes a minute per organization). Tests: `tests/security/rate-limit.test.ts`
(60 parallel hits allow exactly the limit, rollover, isolation, 429 shape, fail-open, routes), and a static
sweep in `tests/security/routes.test.ts` that each listed route calls the limiter first.

## Billing and legal controls added (for reference)

- Stripe webhook: `Stripe-Signature` verified over the raw body (HMAC-SHA256 of `t.body`, any of several
  `v1`, 5-minute tolerance both ways, constant-time), checked before parsing; livemode must match
  `BILLING_MODE`; events deduplicated by id in one transaction (a failure rolls back the claim so Stripe's
  retry reprocesses it); out-of-order subscription events ignored; an event's metadata cannot attach a
  subscription to an organization other than the customer's.
- `BILLING_MODE=live` refuses to start outside production or without a live key; test mode refuses a live
  key; a live key with billing off is flagged (`instrumentation.ts`).
- Outbound Stripe calls only to `api.stripe.com` (`lib/net/outbound.ts`).
- Legal acceptances are append-only (update, delete and truncate blocked by trigger; delete only by the
  organization cascade); no user-role write grant; nothing in code publishes a document (tested).

## Tests added

| File | What it proves |
|---|---|
| `tests/security/rls-coverage.test.ts` | every public table has RLS and a scoped read policy or an allowlisted reason; no open write policy; no RLS-bypassing view |
| `tests/security/tenant-isolation.test.ts` | for every org-scoped table (generated from the catalog), a row seeded for org B is invisible to org A (profile and Shopify sessions) and visible to B |
| `tests/security/credentials.test.ts` | credential tables and secret columns unreadable by user roles; no TRUNCATE/TRIGGER/REFERENCES grants; F-01..F-03 regressions |
| `tests/security/routes.test.ts` | every API route classified; every merchant/billing handler resolves the org from the session, never from the request; mutating handlers pass the CSRF check; every webhook verifies a signature before parsing |
| `tests/security/secrets.test.ts` | no credential pattern in any tracked file; no real env file tracked |
| `tests/security/headers.test.ts` | HSTS, nosniff, referrer, Permissions-Policy, X-Frame-Options, frame-ancestors for the embed; nonce script CSP on `/login`, `/store`, `/shopify` |
| `tests/security/rate-limit.test.ts` | the rate limiter: concurrency, window rollover, key isolation, 429 + Retry-After, fail-open, lead / merchant / webhook wiring |
