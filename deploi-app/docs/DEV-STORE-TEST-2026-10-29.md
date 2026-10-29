# Dev-store install and end-to-end test: run of 2026-10-29

Target: Shopify development store `james-jwtftl1e.myshopify.com`, Dev Dashboard organization "deploi ai" (243698990).
Branch `claude/jolly-ptolemy-kp7ljd` in `deploi-site`, based on `claude/retire-consulting` (365c3a7), which is the
branch that holds the three starter templates and the weekly summary (they are not on `main`). Evidence lives in
`deploi-app/proof/shopify-e2e/` (file names below). Nothing in this run touched production merchant data; the only
production change is the one the precheck asked for.

## What was and was not possible from this session

This session is a cloud container with no browser. The Shopify CLI (5.0.0, installed for this run) offers exactly
one way to sign in from a terminal: a device code that a person must type into `accounts.shopify.com` within a few
minutes. The prompt it printed is in `proof/shopify-e2e/01-shopify-cli-login-attempt.txt` (code `CZMD-KPLM`, now
expired). Nobody was present to enter it, no `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` exist in this environment, in
Vercel, or in the repository, and the Shopify docs state that a CI service-account token
(`SHOPIFY_SERVICE_ACCOUNT_TOKEN`) "can't create apps, run app dev, install apps, or use the Partner API".
So every step that needs the real dev store (app link, install, OAuth, seeding products, billing, uninstall from the
admin, `shopify app webhook trigger`) is **blocked on a human Shopify sign-in**, not on code.

Everything that does not need Shopify credentials was run against the app's synthetic Shopify store (the same
GraphQL operations, answered in-process), on a local production build with a local Postgres, exactly as the
repository's own `DEV-STORE-CHECKLIST.md` and e2e suite do. Those results are labelled **synthetic** below. They
prove the app's behaviour; they do not prove the Shopify side (install screen, token exchange, real webhooks, real
email delivery).

## Pass / fail table

| # | Item | Result | Count | Evidence |
|---|---|---|---|---|
| 0a | Production no longer has `AUTH_MODE=dev` | **Pass** (fixed in this run) | 2 variables moved off Production | `00-precheck-prod-login-before.png` (dev picker shown), `00-precheck-prod-login-after.png` (magic-link form only) |
| 0b | Production deployment IDs reported | **Pass** | app 1 new, site unchanged | section 0 below |
| 0c | Repo has a Shopify app config and which client_id | **Pass** (reported) | 0 linked configs | section 1 below |
| 1a | `shopify app config link` against "deploi ai", no duplicate app | **Blocked** | 0 of 1 | CLI needs a human device-code login |
| 1b | Scopes limited to the three templates, listed per template | **Pass** (prepared, not deployed) | 4 scopes | `shopify.app.deploi-dev.toml.example`, section 1 |
| 1c | Compliance webhooks + app/uninstalled registered | **Blocked** (declared in config, not deployed) | 0 of 4 registered on Shopify | same file; handlers proven in 4c |
| 2a | `shopify app dev --store=james-jwtftl1e` and OAuth install | **Blocked** | 0 of 1 | section 2 |
| 2b | Embedded app loads with session-token auth, no third-party cookies | **Not run live**; code path unit-tested | 11 of 11 Shopify auth/route tests pass | `tests/shopify/auth.test.ts`, `tests/merchant/shopify-routes.test.ts` |
| 2c | Products check, seed 10 (3 under 5) | **Blocked** | 0 of 10 seeded | needs store access |
| 3a | Inventory Watcher: default permissions, detects low stock, alerts | **Pass (synthetic)** | 6 problems found, 5 drafted, 1 needs a person, 1 alert draft | `21-…before-run.png`, `22-…after-run-drafted-changes.png`, `record.json` steps 3a.* |
| 3a' | Inventory Watcher: out-of-grant action blocked, asks for a new grant | **Pass (synthetic)** | 1 task "Needs your approval", 1 "Refused", widening → version 2 waiting for grant | `23-…blocked-task-needs-approval.png`, `24-…version2-waiting-for-grant.png` |
| 3b | Supplier Chaser: chase email only to the test mailbox | **Pass (synthetic draft)** | 1 restock request, 10 low products listed, to the test address only | `30-…review-authorization.png`, `31-…awaiting-approval.png` |
| 3b' | Delivery confirmed, reply path confirmed | **Blocked** | 0 delivered | no email provider; `EMAIL_LIVE_SENDS=off` held the approved send (`32-…held-live-sends-off.png`) |
| 3b'' | Cannot email any other address | **Pass (synthetic)** | 1 task blocked: "someone-else@elsewhere.example is not an allowed recipient" | `33-…other-address-blocked.png` |
| 3c | Store Health Checker: full check, findings, zero writes | **Pass (synthetic)** | 6 problems, 1 needs a person, 1 report draft; 0 executions, 0 write events | `40-…after-run.png`, section 3c |
| 3d | Weekly time-saved summary triggered once | **Pass (synthetic)** | 1 summary prepared (not sent), estimate 11 minutes | `50-…weekly-summary-on-agents-home.png`, `51-weekly-summary-cron-output.json` |
| 4a | Billing: test subscription charge approved, plan status updates | **Blocked** | 0 of 1 | section 4a |
| 4b | Uninstall fires app/uninstalled; tokens revoked; clean reinstall | **Pass (local webhook)** for uninstall; **reinstall blocked** | credentials 1 → 0, connection `uninstalled` | `60-lifecycle-webhooks-output.txt` |
| 4c | Compliance webhooks via `shopify app webhook trigger` return 200 | **Pass (local, signed HTTP)**; CLI trigger **blocked** | 4 topics → 200, unsigned → 401, forged → 401, duplicate → 200 de-duplicated | `60-lifecycle-webhooks-output.txt` |
| 5 | Proof | this document + 16 files in `proof/shopify-e2e/` | | |

Repository checks on this branch before the run: typecheck clean, lint clean, vitest 28 files / 185 tests passed,
production build succeeded, Playwright e2e 29 / 29 passed against the production build (with `DEMO_CONTROLS=true`,
which the demo-reset endpoint needs under `NODE_ENV=production`; `README.md` does not say so).

## 0. Precheck

**AUTH_MODE=dev was still on Production.** Vercel project `deploi-app` (`prj_Wxz1h5poVT6woqvjt66Cl7KFyL6v`,
team `james-ai`) had `AUTH_MODE=dev` (id `2Ewbe8AJHHXq4EjH`) and `ALLOW_DEV_LOGIN=true` (id `Uw8xtJWgVRnC6V2b`)
targeted at Production and Preview, and `https://app.getdeploi.com/login` showed "Development sign-in: pick a seeded
user" (before screenshot). What was done, in order:

1. Both variables re-targeted to **Preview only** (values unchanged there, as `PRODUCTION-SAFETY.md` §2 recommends).
2. The rolled-back production deployment `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X` (commit `fd0e89e`) was redeployed as
   `dpl_4eEqyEPSXcFBn6q166Mt4JaS18YK` (same commit, new environment), built READY in about 60 s.
3. Because the Oct 28 Instant Rollback had paused domain assignment, the new build did not take `app.getdeploi.com`
   on its own; it was promoted to production explicitly.
4. Verified: `https://app.getdeploi.com/login` now returns the magic-link form ("one-time sign-in link") and no user
   picker (after screenshot; `x-vercel-id` changed from `…4wmdh…` to `…ccxg2…`).

Not changed: `APP_SECRET` was not rotated (optional step 6 of the runbook); dev session cookies issued while the
picker was public stay valid until it is. Recommend rotating it.

**Production deployment IDs now:**

| Project | Domain | Deployment | Commit |
|---|---|---|---|
| `deploi-app` | `app.getdeploi.com` | `dpl_4eEqyEPSXcFBn6q166Mt4JaS18YK` (was `dpl_BRTGfUjgMfjcfU6wBwum5kpXJM2X`) | `main` @ `fd0e89e` |
| `deploi-site` | `getdeploi.com`, `www.getdeploi.com` | `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY` (unchanged) | `main` @ `fd0e89e` |

The `b8aad24` deployments (`dpl_2EERM2Hxr5Mro1QkiZ4t1XtqJtkv`, `dpl_BTcc3kvtdDeZhvHvBXMUz4V4iPob`) still exist and still
serve no production domain.

## 1. App config and scopes

- `main` has no Shopify app config at all. The feature branches carry `deploi-app/shopify.app.toml.example` with
  `client_id = "<SHOPIFY_API_KEY>"`: a placeholder, so **no config points at any client_id** and nothing has ever been
  linked. There is therefore no app to reuse; the "Deploi (dev)" app still has to be created in the Dev Dashboard.
- Prepared for that: `deploi-app/shopify.app.deploi-dev.toml.example`. It declares `app/uninstalled`,
  `app/scopes_update`, the product and inventory topics, and the compliance topics `customers/data_request`,
  `customers/redact`, `shop/redact`, all to `/api/shopify/webhooks`.
- Scopes, per template (from `lib/agents/templates.ts` and `lib/connectors/shopify/config.ts`):

| Template | Reads | Writes | Scope(s) |
|---|---|---|---|
| Inventory Watcher | products, variants, inventory levels, locations | `inventoryPolicy` CONTINUE→DENY, only after it is widened past "drafts only" | `read_products`, `read_inventory`, `read_locations`; `write_products` only for the widened mode |
| Supplier Chaser | products, variants, inventory levels (≤ 2 available) | none on the store | `read_products`, `read_inventory`, `read_locations` |
| Store Health Checker | products, variants, inventory levels, locations | none | `read_products`, `read_inventory`, `read_locations` |

  No customer, order, report, publication or inventory-write scope is needed by the three templates. The repository
  default (`SHOPIFY_SCOPES` unset) also asks for `read_publications` and `write_publications`, used only by the
  non-template publication correction; set `SHOPIFY_SCOPES=read_products,read_inventory,read_locations,write_products`
  for the dev app so the code and the TOML agree. `read_reports` is not needed by anything.

## 2. Install

Blocked. To run it, on a machine with a browser:

```bash
cd deploi-app
shopify app config link --client-id <client id of "Deploi (dev)"> --file-name shopify.app.deploi-dev.toml
shopify app dev --config deploi-dev --store james-jwtftl1e.myshopify.com
```

The embedded app route is `/shopify`; it calls `/api/shopify/session` with the App Bridge id token and the server
exchanges it for an expiring offline token (`lib/connectors/shopify/install.ts`). No cookies are used on that path.
`tests/shopify/auth.test.ts` (6) and `tests/merchant/shopify-routes.test.ts` (4) pass, including "the embedded API
authenticates with the Shopify session token". The per-shop `frame-ancestors` policy is tested there too.

## 3. Templates (synthetic store, drafts only unless stated)

All three were created from their template with the most restrictive permission (Shopify: drafts only; email: drafts
only) and granted as version 1. Alert and report recipient: `test-mailbox@northwind-supplier.example`, a synthetic
address that resolves nowhere. `record.json` has every API response.

- **3a Inventory Watcher.** Before the run, the Walnut Serving Board (SKU NW-WSB-01, 12 available) was dropped to
  −2 available with "Continue selling when out of stock" on (`demo.external_change`). The run found 6 problems
  (5 drafted changes On→Off, 1 "needs a person": Cotton Napkins oversold by 3) and drafted one alert email to the
  test mailbox ("Deploi: 1 item needs a person"). Nothing was changed: the variant is still CONTINUE / −2 afterwards,
  and there is no Approve button at drafts only. The task "Fix prices automatically on all products" ended
  **Needs your approval** ("correcting price is not in the agent's rules; the task asks to act without asking; the
  agent is drafts only"), and "Delete the products that have not sold this year" ended **Refused**. Widening the
  policy to "after my approval" produced version 2 **waiting for your grant** with "may now make changes you
  approve (was drafts only)".
- **3b Supplier Chaser.** Granted at drafts only, then widened email to "send messages you approve one by one"
  (version 2, granted). The run drafted one restock request from its own address
  `supplier-chaser.8367dd@agents.getdeploi.test` to the test mailbox only, listing 10 products at ≤ 2 available.
  Approving it ended **Failed: real email sending is turned off in this environment (EMAIL_LIVE_SENDS)**; nothing
  left the machine, so delivery and the reply path are unproven. A task to email `someone-else@elsewhere.example`
  ended Needs your approval: "is not an allowed recipient".
- **3c Store Health Checker.** The run read the whole store: 6 problems found, 1 needs a person, 1 report draft
  ("0 verified, 0 waiting, 1 for a person"). Zero writes: the `executions` table has 0 rows for the store after all
  three runs, the audit trail for the store during the proof run has no `execution.*` event
  (only `agent_run.*`, `scan.completed`, `issue.detected`, `proposal.created`), and the work log says "read access
  under the agent's grant (nothing changed)".
- **3d Weekly summary.** `GET /api/cron/weekly-summary` with the cron secret returned
  `{"results":[{"orgId":"f413054d-…","status":"prepared"}]}`; the row's `status_reason` is "not sent: no email
  provider is configured in this environment". Estimate: **11 minutes** = 0 verified × 3 + 5 drafted × 1 +
  0 sent × 5 + 2 email drafts × 3 + 0 tasks × 2, labelled "Estimate".

## 4. Lifecycle

- **4a Billing: blocked.** The branch has no `appSubscriptionCreate` call path in use: billing is designed around
  Shopify App Pricing (`lib/connectors/shopify/billing.ts`), which needs plans in the Partner Dashboard and Partner
  API credentials (`SHOPIFY_PARTNER_API_TOKEN`, `_ORG_ID`, `_APP_ID`), none of which exist. A `test: true` charge
  cannot be created without store access either. `tests/shopify/billing.test.ts` (1) passes.
- **4b Uninstall.** A signed `app/uninstalled` to the local server returned 200; the connection went
  `active` → `uninstalled` with `uninstalled_at` set, its credential row was deleted (1 → 0) and the audit event
  `connection.uninstalled` was written. **Finding:** on this branch the store's agents stay `status = active` after
  uninstall (they cannot run, there is no connection, but they are not paused); `claude/platform-launch` commit
  `395f37c` ("uninstall pauses agents") fixes this and is not on `claude/retire-consulting`. Reinstall needs a real
  token exchange, so it was not run; `ensureInstalled` re-activation is covered by the shopify-routes test.
- **4c Compliance webhooks.** Fired by signed HTTP (the same thing `shopify app webhook trigger` sends):
  `customers/data_request` 200, `customers/redact` 200, `shop/redact` 200 (connection and organization erased),
  `app/uninstalled` 200; unsigned 401, wrong-secret 401, repeated delivery id 200 with `duplicate: true`. All
  receipts are `processed` in `webhook_receipts`. The CLI `webhook trigger` itself is blocked with the rest.

## 5. Not completed, and why

| Item | Why | What unblocks it |
|---|---|---|
| 1a, 1c, 2a, 2c, 4a, 4b reinstall, 4c via CLI | Shopify CLI sign-in needs a person at a browser; no app credentials exist anywhere reachable | A person runs the two commands in section 2 once (5 minutes); after that `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` from the Dev Dashboard let the server run `app dev` from any machine |
| 3b' delivery and reply | No email provider configured; sends off by policy until `LAUNCH-STEPS.md` step 2 | `RESEND_API_KEY`, `AGENT_MAIL_DOMAIN`, `EMAIL_LIVE_SENDS=allowlist`, `EMAIL_TEST_RECIPIENTS=<test mailbox>` |
| 2b live | Needs the embedded app inside the Shopify admin | same as 1a |

Commit SHAs for this run are in the pull request; the only code added is the proof script, the config example and
this document. The production environment change (section 0) is in Vercel, not in git.

---

# Second pass (same day): production security fix finished, branch hygiene, optional write scope

Branch `claude/jolly-ptolemy-kp7ljd`, commits after the first pass: `9c92c90` (cherry-pick of `395f37c`), `42ff462`
(optional write scopes, docs), `84d9ffb` (proof scripts). Checks on the final head: typecheck clean, lint clean,
vitest **31 files / 200 tests** passed, production build succeeded, Playwright e2e **29 / 29 passed** against the build.
New evidence in `proof/shopify-e2e/` (29 files now).

## Pass / fail, with live vs synthetic

| # | Item | Result | Live or synthetic | Count / id | Evidence |
|---|---|---|---|---|---|
| A1 | Rotate `APP_SECRET` on Production, redeploy, old sessions invalid | **Pass** | Live (production) | var `SeByQWN8kJsF9GxG` updated 19:44:23 UTC; deployment `dpl_Dxe8DZQBkx3rUo4NqkjAV7cNnUbS` (commit `fd0e89e`), READY in 67 s, aliased to `app.getdeploi.com` by Vercel itself (auto-assignment was back on after the earlier promote) | `02-prod-login-after-secret-rotation.png`, `03-prod-old-cookie-rejected.txt` |
| A2 | Dev-picker sign-ins while `AUTH_MODE=dev` was live | **0 found in the retained window; earlier days not retrievable** | Live (Vercel runtime logs) | see below | section A2 |
| A3 | `AUTH_MODE` / `ALLOW_DEV_LOGIN` on Preview only; guard refuses production with dev auth; test | **Pass** | Live env check + local build | both vars `target: ["preview"]`; guard test 7/7; real `next build` with `VERCEL_ENV=production AUTH_MODE=dev ALLOW_DEV_LOGIN=true` exits 1 | `04-prod-build-refuses-dev-auth.txt`, `tests/security/production-auth.test.ts` |
| B4 | Cherry-pick `395f37c`; uninstall pauses agents, credentials 1 → 0 | **Pass** | Synthetic store, real webhook handler | `9c92c90`; 5 agents active → paused; credentials 1 → 0; audit `connection.uninstalled {agents_paused: 5}` | `70-uninstall-before-agents-active.png`, `71-uninstall-after-agents-paused.png`, `72-uninstall-record.json` |
| B5 | Plan to get the templates onto `main` | **Pass (plan, nothing merged)** | n/a | 3 branches compared; 38 conflicts platform-launch → retire-consulting; 0 conflicts retire-consulting → main | `docs/MERGE-PLAN-TEMPLATES-TO-MAIN.md` |
| B6 | README: `DEMO_CONTROLS` and every new env var | **Pass** | n/a | 17 variables documented | `README.md` |
| B7 | Delete `claude/jolly-ptolemy-kp7ljd` on `Jamesrevenueai/Jamesrevenueai` | **Blocked** | Live (GitHub) | `git push --delete` → HTTP 403 from the session's git proxy (ref deletion is not allowed from here); the branch equals `main` (`dfadae8`) | one click for you: GitHub → branches → delete |
| C8 | Install scopes read only; `write_products` optional, requested only when widening | **Pass** | Synthetic store (Shopify's grant screen simulated); real App Bridge call wired for the embedded app | required 3, optional 3; drafts need 0 extra; widening reports `["write_products"]`; approve → `blocked: missing permission: write_products`; after grant + sync → `[]`; tests 3 + 1 | `80-scope-notice-before-shopify-grant.png`, `81-write-blocked-missing-permission.png`, `82-scope-notice-after-shopify-grant.png`, `83-scope-record.json` |
| D9 | "READY FOR SHOPIFY LOGIN" | **Sent with this report** | | | |
| D10 to D12 | Live dev-store run, billing, email delivery | **Waiting on your sign-in** | | | first-pass table rows 1a to 4c |

### A1 detail

`APP_SECRET` was rotated to a new 64-character random value (never printed, never committed) on Production and
Preview, then the production deployment was rebuilt so the new value is baked in. Proof that earlier cookies are dead:
a dev-session cookie signed with a different secret (which is what every cookie issued before rotation now is) sent to
`/app/home`, `/staff/pipeline` and `/staff` gets **HTTP 307 → /login** on all three. Note that production has been in
Supabase mode since the first pass, so dev cookies were already ignored there; the rotation closes the case where the
variables are ever set again. `x-vercel-id` on the login page changed to `…792fm…` (new deployment).

### A2 detail: dev-picker sign-ins

The dev sign-in action logs `auth.dev.signin` with the picked user's id and role (no IP, no user agent: the app never
logged those). Vercel runtime logs for `deploi-app` Production, searched for that message:

| Window | Method | Result |
|---|---|---|
| last 7 days (2026-10-22 19:46 → 2026-10-29 19:46 UTC) | grouped count by deployment, query `auth.dev.signin` | **0** |
| last 7 days, all log lines by request path | grouped count | `/api/cron/morning-report` 176, `/api/cron/workers` 29, `/api/cron/morning-pipeline` 14, `/` 4, `/login` 1 |
| the one `/login` line | full text | 2026-10-28 16:42:53 UTC, deployment `dpl_2EERM2Hxr5Mro1QkiZ4t1XtqJtkv` (the `b8aad24` build that was rolled back), a **server error** (`column g.org_type does not exist`) on the login page render, not a sign-in |
| 2026-10-20 23:28 (variables created) → 2026-10-22 19:46 | any | **not retrievable**: every query over that range times out in Vercel's log store; retention on this plan does not reach it |

So: **0 dev-picker sign-ins in the retained 7 days.** The first ~2 days after the variables were set cannot be
checked from logs, and the app keeps no database record of dev sign-ins. Nothing to flag; nothing to clear either.

### C8 detail

- `shopify.app.toml` (both examples): `scopes = "read_products,read_inventory,read_locations"`,
  `optional_scopes = ["write_products", "read_publications", "write_publications"]`. Shopify's docs confirm optional
  scopes must be declared there, are requested with App Bridge `shopify.scopes.request([...])` (Shopify shows its own
  grant screen), and are reported back through `currentAppInstallation.accessScopes` and `app/scopes_update`.
- Code agrees: `config.ts` `REQUIRED_SCOPES` / `OPTIONAL_SCOPES` (env overrides `SHOPIFY_SCOPES`,
  `SHOPIFY_OPTIONAL_SCOPES`). The scan query drops publication fields until `read_publications` is granted, so a
  read-only install does not hit `ACCESS_DENIED`.
- Flow: widening an agent past drafts only returns `missingScopes`; the agent page shows "Shopify has not given Deploi
  permission to change product settings (write_products)" with an **Ask Shopify for this permission** button inside the
  admin (App Bridge), and the server re-reads the granted list (`POST /api/store/scopes/sync`). Until then every
  approved write ends **Blocked: missing permission: write_products** and nothing is written. Live verification of the
  App Bridge grant screen itself is part of D11.

## Still needing you

1. **Reply "ready"** for the Shopify device-code login (D9); I will then create "Deploi (dev)" (after checking for a
   duplicate), link, deploy, and run D11 live.
2. **`RESEND_API_KEY` and a test mailbox** for D12 (else the chase email stays held).
3. **Delete** `claude/jolly-ptolemy-kp7ljd` in `Jamesrevenueai/Jamesrevenueai` (B7; blocked from this session).
4. **Approve** the merge order in `docs/MERGE-PLAN-TEMPLATES-TO-MAIN.md` (PR #6 → `claude/retire-consulting`, then
   PR #5 re-based onto `main`), and the competitor-watcher choice.
