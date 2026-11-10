# Phase 1 report, 2026-11-10 (A–E; F–H are the other three files)

## A. Variables the app reads (names and scopes only, no values)
Source: `lib/env.ts`, `lib/auth-guard.ts`, `lib/connectors/shopify/config.ts`, plus Vercel API listing of deploi-app (`prj_Wxz1h5poVT6woqvjt66Cl7KFyL6v`).

**Database:** the app reads only `DATABASE_URL` (`lib/env.ts`). `DATABASE_URL_POOLED` was read by nothing: **fixed in this push** (fallback `DATABASE_URL || DATABASE_URL_POOLED`, `tests/security/database-url-fallback.test.ts`, 3/3).
**Shopify:** `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_API_VERSION`, `SHOPIFY_APP_HANDLE`, (`SHOPIFY_SCOPES`, `SHOPIFY_OPTIONAL_SCOPES` optional overrides).

| Variable | Preview | Production | Flag |
|---|---|---|---|
| DATABASE_URL | branch `…platform-launch` (stale, created 11-06, old password); branch `…operating-system` | set | **Stale branch value overrides the new pooler string. Delete it.** |
| DATABASE_URL_POOLED | all Preview, Sensitive, updated 11-08 | n/a | now used as fallback |
| SHOPIFY_API_KEY | branch `…platform-launch` = Deploi (dev) id; **and** a `jolly-ptolemy` copy | **missing** | |
| SHOPIFY_API_SECRET | all Preview (created 11-06); **and** a `jolly-ptolemy` copy | **missing** (so prod webhooks answer 503, not 401) | |
| SHOPIFY_APP_URL | branch `…platform-launch` = dev.getdeploi.com; jolly copy | **missing** | |
| SHOPIFY_API_VERSION | branch `…platform-launch` = 2026-10 | **missing** | |
| SHOPIFY_APP_HANDLE | missing | missing | needed for plan URLs only if billing is on |
| CREDENTIALS_ENCRYPTION_KEY / _KEY_ID | branch copies (launch-k1, pr16-k1, jolly) | **missing** (you said it was saved) | add `prod-k1` |
| STORE_ACCESS_MODE | missing | **missing** | needs `open` for review |
| AUTH_MODE, ALLOW_DEV_LOGIN | **still present** (supabase / false, all Preview) | absent | neutralized, not deleted |
| DEVSTORE_ADMIN_TOKEN | absent | absent | deleted ✓ |
| NEXT_PUBLIC_SUPABASE_URL | all Preview | set | |
| NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY | **absent on Preview** | set | Preview has no Supabase sign-in keys; embedded Shopify auth does not need them |
| APP_SECRET, CRON_SECRET, STAFF_EMAILS, NEXT_PUBLIC_APP_URL, PUBLIC_API_ALLOWED_ORIGINS | set | set | |
| EMAIL_LIVE_SENDS, AGENT_MAIL_DOMAIN, RESEND_API_KEY | branch copies (off / .test) | missing | |

**jolly-ptolemy Shopify vars: delete them.** The branch's Neon database is gone, nothing reads them, and one is a dev client secret.
Dev auth is provably inert even while the two vars exist (`resolveAuthMode` needs `ALLOW_DEV_LOGIN==='true'`), but I held to your rule: Vercel Authentication stays **on** until they are deleted.

## B. Vercel Authentication: NOT switched off (gate failed)
Before state (2026-11-10 03:29 UTC): `ssoProtection: all_except_custom_domains`; `curl -sI https://dev.getdeploi.com/` → `302 → vercel.com/sso-api`; unsigned webhook → `401` **from Vercel's login wall, not the app**; screenshot `proof/phase1/dev-before-loggedout.png`. Database: unreachable (stale password, see A).

## C. Dev app config: DONE
Linked `ec6e664e…` → `shopify.app.deploi-dev.toml` (no secrets), deployed from `.example`: **version `deploi-dev-5`, ID 1201516511233, status active**, message "Dev app config from template 2026-11-10". Previous: `dev-20261110-0329-707265b` (inactive). The remote config already matched; scopes `read_discounts,read_inventory,read_locations,read_products,write_products`, optional `read_publications,write_publications`, 9 topics + 3 compliance topics, redirect `https://dev.getdeploi.com/api/shopify/auth/callback`. Released-version screenshot: needs a dashboard login I do not have; version URL: https://dev.shopify.com/dashboard/243698990/apps/441654870017/versions/1201516511233

## D. getdeploi.com: already live from your earlier deploy, verified
Production `dpl_3VocEzdHgSm9a1w6Eghmdiiogri3` (SHA 9441dff), state READY; rollback candidate kept. Live render of /privacy /terms /support: LLC name present, "Columbus, Ohio, USA" present, support@ present, "DRAFT" absent, "pending legal" absent, hello@ and gmail absent, no street address. Grep of the repo: "DRAFT"/"pending legal" appear only in 2 test files that assert their absence (3 lines). Before/after pair: before = deployments before 9d51e9b (the banner existed; no pre-change capture is in this session), after = `proof/phase1/live-{privacy,terms,support}-after.png`. Entity/location come from one value: `src/lib/brand.ts` `LEGAL`.

## E. Email (DNS verbatim, Cloudflare DoH, 2026-11-10)
- MX getdeploi.com: `10 mxa.mailgun.org.`, `10 mxb.mailgun.org.`
- SPF: `v=spf1 include:mailgun.org ~all`
- DMARC `_dmarc`: `v=DMARC1; p=reject; pct=100; fo=1; ri=3600; sp=reject; adkim=s; aspf=s; rua=mailto:32a1088@dmarc.mailgun.org,mailto:7a82e45f@inbox.ondmarc.com; ruf=mailto:32a1088@dmarc.mailgun.org,mailto:7a82e45f@inbox.ondmarc.com;`
- DKIM `mailo._domainkey`: `k=rsa; p=MIGfMA0GCSqG…IDAQAB` (present)
- `resend._domainkey`, `send.`, `agents.` records: **none**.
- Forwarding: I cannot send mail from here, so I cannot prove it. The MX is correct for Squarespace forwarding; the first bounce is consistent with DNS caching. **Unproven: please retest.**
- Does the app send from @getdeploi.com? **Yes**: invites, owner notices, weekly summaries from `support@getdeploi.com` (`lib/email/system.ts`), agent mail from `<agent>@agents.getdeploi.com`, both via **Resend**, off while `EMAIL_LIVE_SENDS=off`. With no Resend DKIM and `p=reject; adkim=s`, that mail would be rejected. Needed DNS: what Resend shows for `getdeploi.com` (resend._domainkey TXT, send MX + TXT) and for `agents.getdeploi.com`. The Zoho steps in the old click list no longer apply.

## I (Phase 2) note
The Supabase Management API token is rejected from this environment ("Invalid access token"), so I cannot run VERIFY-READONLY PART 2 myself. You will paste it in the SQL editor; I tell you which rows.
