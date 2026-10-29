# Production safety: what is live, what is wrong, and the exact fix

Re-checked on **2026-10-29 (about 13:15 UTC)** through the Vercel API (team `james-ai`, read only) and the
read-only `scripts/verify-production-login.mjs`. Nothing in production was changed by this work. Earlier
findings from 2026-10-28 are kept in section 4.

## 1. LAUNCH BLOCKER: public development sign-in on app.getdeploi.com (still open)

Evidence, 2026-10-29:

```
$ node scripts/verify-production-login.mjs https://app.getdeploi.com
PASS  /login answers 200  (status 200)
FAIL  /login says "We will email you a one-time sign-in link"
FAIL  /login has no development sign-in text
FAIL  /login has no user picker
FAIL  /login lists no staff accounts  (hello@getdeploi.com, ojae@getdeploi.com, admin@buckeyehomecare.example, admin@sciotovalley.example)
FAIL  /api/health reports auth "supabase"  (auth=dev)
PASS  /staff with a forged dev cookie redirects to /login  (status 307 → /login)
PASS  /store with a forged dev cookie redirects to /login  (page not in this deployment)
3 passed, 5 failed
```

Anyone can open `https://app.getdeploi.com/login`, pick `hello@getdeploi.com · staff` and be signed in as
staff without a password. Cause (Vercel → `deploi-app` → Environment Variables):

| Variable | Value | Targets |
|---|---|---|
| `AUTH_MODE` | `dev` | **production and preview (one entry)** |
| `ALLOW_DEV_LOGIN` | `true` | **production and preview (one entry)** |
| `APP_SECRET` | (sensitive) | production and preview (one entry) |

Each variable is a **single entry shared by Production and Preview**. "Delete" would remove it from Preview
as well; to keep dev sign-in on Preview, edit the entry and untick Production instead.

## 2. Remediation, in order (needs the owner; I did not change production)

Total time about 20 minutes. Steps 1–5 close the hole without deploying any new code.

1. **Stop-gap, if you cannot do the rest right now:** Vercel → `deploi-app` → Settings → **Pause project**.
   The app goes offline (fails closed). Unpause later.
2. **Staff sign-in will need a mailbox.** After this change, sign-in is by emailed one-time link (Supabase).
   `STAFF_EMAILS=hello@getdeploi.com`, but **getdeploi.com has no MX record today** (checked 2026-10-29), so
   that address cannot receive the link. Before step 3, either set up a mailbox for `hello@getdeploi.com`
   (Google Workspace or similar, which adds MX records), or change `STAFF_EMAILS` (Production) to an address
   you can receive, and update the database setting to match:
   `alter database postgres set app.staff_emails = '<same list>';` (Supabase → SQL editor).
   Supabase's built-in mailer is rate limited (a few emails per hour); for more than a handful of sign-ins set
   up custom SMTP in Supabase → Authentication → SMTP (Resend works, once its domain is verified).
3. Vercel → `deploi-app` → Settings → Environment Variables:
   - `AUTH_MODE` → **Edit** → untick **Production** → Save. (Or Delete if you do not want it on Preview either.)
   - `ALLOW_DEV_LOGIN` → same.
   - Confirm `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` cover Production (they do today).
4. **Rotate `APP_SECRET`, separately for Production and Preview.** Generate two values with
   `openssl rand -base64 48`. Edit `APP_SECRET`, untick Preview, save the first value for Production; then
   **Add** `APP_SECRET` for Preview only with the second value. Why both, and separate:
   - `APP_SECRET` signs dev session cookies only. Cookies issued while the picker was public are signed with
     the current secret and **also work on every Preview deployment**, which shares the same secret today.
   - Rotating invalidates every such cookie (tested: `tests/unit/auth.test.ts`, "rotating APP_SECRET
     invalidates every existing dev cookie").
   - The new code (this release) additionally ignores dev cookies in production at every layer, requires a
     32+ character secret (no built-in default), and expires dev cookies after 7 days; cookies without an
     expiry (every cookie issued so far) are rejected outright.
   - Supabase sessions are not signed with `APP_SECRET`. No Supabase session exists for anyone who used the
     picker. To end all Supabase sessions anyway: rotate the JWT secret (Supabase → Project Settings → API),
     which signs everyone out.
5. **Redeploy without new code:** Deployments → `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` → ⋯ → **Redeploy**
   (untick "use existing build cache"). Because the earlier Instant Rollback paused automatic domain
   assignment, choose ⋯ → **Promote to Production** on the new build if the domains do not move on their own.
6. **Verify** from `deploi-app/`: `node scripts/verify-production-login.mjs https://app.getdeploi.com` must end
   `… passed, 0 failed`. For the strongest check, also run it with `DEV_TEST_SECRET=<the OLD secret>` and
   `DEV_TEST_UID=<a staff profile id>`: the old secret signs a valid-looking staff cookie, which must be ignored.
7. **Review what happened while the picker was public.** Supabase → SQL editor (read only):
   `select e.at, p.email, e.table_name, e.action, e.ip from audit_events e left join profiles p on p.id = e.actor_id where e.at > '2026-10-20' order by e.at desc limit 300;`
   (`engine_audit` does not exist in production yet: it comes with migration 28.) Every insert, update and
   delete, and the audited reads, carry the actor and IP. Anything not done by you or Ojae is an incident.
8. **Protect `main`** (`LAUNCH-STEPS.md` step 1) so a push cannot redeploy production without review.

## 3. What this release changes (draft PR, not merged, not deployed)

- **Dev auth can never run in production** (PR #2, merged into this branch): the build fails, the server
  refuses to start, and auth mode always resolves to Supabase when `VERCEL_ENV=production` or
  `DEPLOI_ENV=production`. If this release is merged while the variables are still set, the production build
  fails and Vercel keeps the previous deployment, so section 2 step 3 must come first.
- **Dev sessions**: no default secret; 32+ characters required; signed `iat`/`exp`, 7-day maximum; legacy
  cookies refused.
- **Queued work cannot act after pause, revoke, uninstall or expiry.** Store writes pass an atomic last gate
  immediately before the write (agent row share-locked, the same authorization version still active, store
  still connected, execution still `prechecking`); pause and revoke also close executions that are mid-precheck.
  Email sends share-lock the agent before claiming the message (same lock order as pause). Uninstall pauses
  every agent of the store and cancels queued email. Standing authorizations re-check `validUntil` on the
  fresh record at the moment of writing or sending. Scheduled runs re-check they are due under the lock.
  Tests: `tests/security/queued-work.test.ts` (the two precheck tests fail on the previous code).
- **Tenant isolation**: merchant reads run under Postgres RLS as the actor; state changes check
  `assertMerchant`. New: staff cannot start scans or demo resets on a merchant store; the template timezone
  lookup runs under RLS; Resend inbound mail without a routing address is dropped instead of being filed under
  the oldest organization. Tests: `tests/merchant/isolation.test.ts`, `tests/competitors/watcher.test.ts`,
  `e2e/security.spec.ts`, `e2e/competitor.spec.ts`.
- **Webhooks**: a Shopify delivery that failed is processed again on retry (it used to be acknowledged as a
  duplicate, so a failed `app/uninstalled` never ran); Resend inbound is deduplicated by `svix-id`.
- **Cron routes fail closed** without `CRON_SECRET` on any Vercel deployment or production build;
  `?force=1` no longer bypasses auth for anonymous callers.
- **Secrets are never logged**: `lib/log.ts` redacts identifying keys; the engine audit scrubs any key named
  like token/secret/password/cookie/ciphertext.

## 4. Background (verified 2026-10-28, unchanged)

- Production domains point at `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` (app) and `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY`
  (site), both built from `main` @ `fd0e89e`, after an Instant Rollback from `b8aad24`.
- `b8aad24` was pushed straight to `main` and deployed engine code whose migrations (28…) were not applied.
  `main` still contains that code: **merging anything into `main` deploys code that needs migrations 28–29**.
  See `RELEASE-PLAN.md` for the safe order.
- Each Vercel project builds only when its own files change (`ignoreCommand`).
- On the public internet `getdeploi.com` still resolves to Squarespace (`LAUNCH-DNS.md`).
