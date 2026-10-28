# Production safety: what is live, what went wrong, and how to fix it

Checked on 2026-10-28 (about 19:00 UTC) through the Vercel API (team `james-ai`). Nothing in production was changed by this work.

## 1. What is serving production right now (verified)

| Project | Production domains point at | Built from | Rollback requested to | Rollback in effect? |
|---|---|---|---|---|
| `deploi-app` (`prj_Wxz1h5poVT6woqvjt66Cl7KFyL6v`) | `app.getdeploi.com`, `deploi-app.vercel.app` → **`dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X`** | `main` @ `fd0e89e` | `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` | **Yes** |
| `deploi-site` (`prj_Xb6Vx6VaNR5c4UKboR52N2hDIq1v`) | `getdeploi.com` (and `gotdeploi.com`, which 308-redirects to it) → **`dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY`** | `main` @ `fd0e89e` | `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY` | **Yes** |

How this was checked: `GET /v4/aliases/{domain}` for each production domain. Each alias's `deploymentId` is the rolled-back deployment. The `b8aad24` deployments (`dpl_2EERM2Hxr5Mro1QkiZ4t1XtqJtkv` app, `dpl_BTcc3kvtdDeZhvHvBXMUz4V4iPob` site) still exist but no production domain points at them.

Note: on the public internet `getdeploi.com` still resolves to Squarespace, because its DNS is at Squarespace (see `LAUNCH-DNS.md`). The Vercel alias above only takes effect once DNS points at Vercel.

## 2. Still open: dev sign-in is public on production (not fixed; your decision)

`https://app.getdeploi.com/login` (the rolled-back deployment) shows **"Development sign-in: pick a seeded user"**. It lists `hello@getdeploi.com · staff`, `ojae@getdeploi.com · staff` and two client users, and lets anyone sign in as any of them without a password.

Cause: the `deploi-app` Production environment has `AUTH_MODE=dev` and `ALLOW_DEV_LOGIN=true`. Vercel bakes environment variables into each deployment, so the rolled-back deployment has them too. Removing the variables affects only the next deployment.

You asked me to leave production alone for now. These are the exact steps when you are ready:

1. Vercel → `deploi-app` → Settings → Environment Variables.
2. Delete `AUTH_MODE` and `ALLOW_DEV_LOGIN` from **Production**. You can keep them on **Preview**, which is protected by Vercel Authentication.
3. Check that `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set for Production (they are today), so the app uses Supabase magic-link sign-in.
4. Redeploy the current production deployment without the build cache: Deployments → `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` → ⋯ → Redeploy. The redeploy picks up the new variables and keeps the same commit (`fd0e89e`).
   Because the rollback paused automatic domain assignment, the new build may not take over the domains on its own. If it does not, choose ⋯ → Promote to Production on it.
5. Verify: run `node scripts/verify-production-login.mjs https://app.getdeploi.com` from `deploi-app/`. It sends GET requests only and must end `… passed, 0 failed`. It checks:
   - `/login` says "We will email you a one-time sign-in link";
   - `/login` has no user picker and no staff accounts;
   - `/api/health` reports `supabase`;
   - a dev session cookie is ignored.

   On 2026-10-28 it fails against production, as expected (dev sign-in is still on): 3 passed, 5 failed.
6. Optional, because it signs dev cookies: rotate `APP_SECRET` on Production at the same time. That invalidates any dev session cookie issued while the picker was public.

Fastest stop-gap if you want it closed before redeploying: Vercel → `deploi-app` → Settings → Pause project. This takes `app.getdeploi.com` offline (fails closed). It is reversible with Unpause.

## 3. Why a push to `main` redeployed the app (cause, verified)

- **The project connections are correct.** Both projects link to `Jamesrevenueai/deploi-site`. `deploi-app` builds the `deploi-app/` root directory: its build log shows `> deploi-app@0.1.0 build` and Next.js detected. `deploi-site` builds the repository root with Vite.
- **The cause was pushes to `main`.** Every push to `main` builds both projects as Production. The commits `f1f6e87`, `f0963ff` and `b8aad24` were pushed straight to `main`. The app deployment from `b8aad24` contained engine code whose database migrations (`20261028000028`…) had not been applied to production.
- **After an Instant Rollback**, Vercel stops assigning production domains to new deployments until you promote one. This is why the rollback held. Its MCP API does not expose that flag, so I could not read it back. In the dashboard, Deployments shows a banner while auto-assignment is paused. Do not click "Undo rollback" or promote a later build until it has passed review.

## 4. What this work changes (draft PR #2, base `main`, not merged)

- **Production refuses dev auth at three layers** (`lib/auth-guard.ts`). Production means `VERCEL_ENV=production`, or `DEPLOI_ENV=production` on any other host.
  1. `next.config.ts` fails the build. Vercel keeps the previous deployment live.
  2. `instrumentation.ts` refuses to start the server.
  3. The auth mode always resolves to `supabase`, the dev picker is hidden, `devSignIn` is refused and dev cookies are ignored.

  Tests: `tests/security/production-auth.test.ts`. Proven on a real build:

  ```
  $ VERCEL_ENV=production AUTH_MODE=dev ALLOW_DEV_LOGIN=true next build
  Error [ProductionAuthError]: Refusing to run: AUTH_MODE=dev and ALLOW_DEV_LOGIN=true set in a production environment. ...
  exit=1
  ```

  If PR #2 is merged while the variables are still set, the production build fails and production stays on the current deployment. So do section 2 first.
- **Each project builds only when its own files change** (`ignoreCommand` in each `vercel.json`). A website commit can no longer redeploy the app, and an app commit can no longer redeploy the website.

## 5. Recommended (needs you; I cannot change these)

- GitHub → `deploi-site` → Settings → Branches → protect `main`: require a pull request and one approval, and block force pushes. This stops direct pushes from deploying production.
- Keep merges to `main` as the only way to deploy production, and merge only after the owner approves.
