# Deploying deploi-app

## 1. Supabase project "deploi-prod"
1. supabase.com → New project → name `deploi-prod`, region us-east, strong DB password.
2. Project Settings → Database → Connection string → **Transaction pooler** URI → `DATABASE_URL`.
3. Project Settings → API → Project URL → `NEXT_PUBLIC_SUPABASE_URL`; anon key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`; service_role key → `SUPABASE_SERVICE_ROLE_KEY`.
4. Authentication → URL configuration: Site URL `https://app.getdeploi.com`, redirect `https://app.getdeploi.com/auth/callback`.
   Authentication → Email: enable magic link (OTP), optionally use Resend SMTP from hello@getdeploi.com.
5. Apply the schema: `DATABASE_URL=<direct connection string> npm run db:migrate` (or `supabase db push` with the CLI; the folder follows its convention).
6. Tell Postgres who is staff (used by the profile trigger):
   `alter database postgres set app.staff_emails = 'hello@getdeploi.com,<your email>';`
7. Staff logins: `DATABASE_URL=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed`
   (creates the staff auth users through the admin API; idempotent). It also adds two synthetic merchants;
   skip it on production if you do not want them, and create staff users in Supabase Auth instead.

## 2. Vercel project "deploi-app" (team james-ai)
1. Vercel → Add New → Project → import the `deploi-site` GitHub repository → **Root Directory: `deploi-app`** → Framework Next.js → name `deploi-app`.
2. Domains → add `app.getdeploi.com` (CNAME `app` → `cname.vercel-dns.com` at the DNS host for getdeploi.com).
3. Environment variables: every key in `.env.example`. Minimum for production:
   `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `AUTH_MODE=supabase`, `APP_SECRET`, `STAFF_EMAILS`, `NEXT_PUBLIC_APP_URL=https://app.getdeploi.com`,
   `PUBLIC_API_ALLOWED_ORIGINS=https://getdeploi.com,https://www.getdeploi.com`, `CRON_SECRET`,
   `RESEND_API_KEY`, `AGENT_MAIL_DOMAIN`, `AGENT_MAIL_WEBHOOK_SECRET`, the `SHOPIFY_*` keys,
   `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_ID`. Keep `EMAIL_LIVE_SENDS=off` and `LIVE_WRITE_STORES` empty
   until launch is approved (`docs/LAUNCH-STEPS.md`).
4. Crons come from `vercel.json`: agent runs hourly at minute 7, the weekly summary Mondays 13:13 UTC.
   The Hobby plan allows only daily crons; use Pro or change the schedules.

## 3. deploi-site (marketing)
Set `VITE_APP_API_URL=https://app.getdeploi.com`, `VITE_BOOKING_URL`, `VITE_LEGAL_ENTITY`, `VITE_LEGAL_REVIEWED`
on the existing `deploi-site` project. Note: the Vercel project currently serves `gotdeploi.com`;
`getdeploi.com` is registered on the team but not attached to the project.

## 4. Tables left from the home-care consulting service
The consulting code was removed on 2026-10-29. Its tables (EVV visits and rules, aides, referrals, assessments,
engagements, pilots, economics, service tickets, credit ledger and others in `supabase/migrations/2026102*`) are
still in the schema and still hold production data. Nothing in the app reads or writes them any more.
Dropping them needs a new migration and the owner's approval; no such migration exists yet. `agencies` is
not one of them: it is the organization table for merchants (`org_type = 'merchant'`), and `prospects` and
`touches` hold early access applications.
