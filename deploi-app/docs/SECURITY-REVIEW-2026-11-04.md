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
| F-06 | Medium | No script/style Content-Security-Policy (only `frame-ancestors`) | Open |
| F-07 | Medium | Shopify `customers/redact` and `customers/data_request` answer "no customer data held"; untrue once order/customer agents or agent e-mail hold shopper data | Open |
| F-08 | Medium | Any member of an organization (or any Shopify admin user of the store) can grant agent authorizations; no owner-only role | Open |
| F-09 | Medium | With billing on, `/api/store/plan` would let a merchant switch to any tier for free | Fixed |
| F-10 | Low | Monthly agent-action allowance is shown but not enforced at run time | Fixed |
| F-11 | Low | A downgrade arriving by Stripe webhook updates the tier but does not switch off library agents the new tier excludes (the merchant-initiated path does) | Fixed |
| F-12 | Low | No rate limit on the public early-access form or on sign-in link requests (beyond Supabase's own) | Open |
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

### F-06 Medium — no script CSP (Open)
`middleware.ts` sets only `frame-ancestors`. A nonce-based `script-src` (Next.js supports nonces via
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

### F-08 Medium — no owner-only grants (Open)
Every signed-in member and every Shopify admin user of the store can grant and widen agents. The AI Agent
Authorization Terms place the responsibility on the customer (REVIEW-CHECKLIST A-2); a product control
(owner/admin role for grants and billing) is recommended before general availability.

### F-09 Medium — free tier switch with billing on (Fixed)
`POST /api/store/plan` sets `agencies.plan_tier` (which decides which library agents can be switched on)
without payment. Harmless in the free beta; with `BILLING_MODE` on it would bypass payment. The route
now refuses while billing is on (one line); the tier follows the Stripe subscription
(`lib/billing/webhooks.ts`). Tested in `tests/billing/stripe-flow.test.ts`.

### F-10, F-11 Low (Fixed), F-12 Low (Open)
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
- F-12: add per-IP rate limits (Vercel Firewall rules) for `/api/public/lead` and `/login`.

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
| `tests/security/headers.test.ts` | HSTS, nosniff, referrer, Permissions-Policy, X-Frame-Options, frame-ancestors for the embed |
