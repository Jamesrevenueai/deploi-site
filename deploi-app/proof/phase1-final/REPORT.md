# Phase 1 final proof, 2026-11-11

Deployment `dpl_8mUhPAtfi8s42GkyX6z5DKBbaHb7` (redeploy of `dpl_5DirRtdrHcxXLPLfd7j7HBHPh32y`), SHA `6c5d81d20a5a8cd16a6a466726b755e636d30949`, aliased to dev.getdeploi.com.

| Check | Before | After |
|---|---|---|
| `GET /` | 307 → /login | 307 → /login (no Vercel SSO) |
| Unsigned webhook | 401 `{"error":"invalid hmac"}` from the app | same, from the app (JSON body, no SSO redirect) |
| DB read (deploi-preview, `/api/health`: `select 1` + job queue stats) | reachable, 420 ms | reachable, 235 ms, queue depth 20 |
| Dev sign-in on dev.getdeploi.com | absent | absent |
| `/api/admin/devstore` | | 404 (no DEVSTORE_ADMIN_TOKEN) |
| `/api/store/demo` unauthenticated | | 401 |

Env verified via Vercel API: AUTH_MODE, ALLOW_DEV_LOGIN, branch DATABASE_URL (launch + operating-system), all jolly-ptolemy vars: gone. Production: STORE_ACCESS_MODE=open, CREDENTIALS_KEY_ID=prod-k1 present. ssoProtection null.

## Exposure found and closed
With Vercel Authentication off, 39 of 96 older preview deployments (built while ALLOW_DEV_LOGIN=true) served
"Development sign-in" (pick any seeded user) against the reachable deploi-preview database (synthetic data;
seeded profile emails listed). Old builds are immutable, so this cannot be fixed in code.
Fix: Vercel Firewall custom rule "Previews only via dev.getdeploi.com" (environment = preview AND host != dev.getdeploi.com → deny).
Result: 91/91 preview deployment URLs → 403; dev.getdeploi.com 200; app.getdeploi.com 200.
Runtime logs: 0 `auth.dev.*` events in the last 24 h (no one used it).
Recommended: delete the old preview deployments when convenient.

Screenshots: before-signin.png / after-signin.png, before-health.png / after-health.png, after-old-preview-blocked.png.
