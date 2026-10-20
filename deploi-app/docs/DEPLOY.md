# Deploying deploi-app

## 1. Supabase project "deploi-prod"
1. supabase.com → New project → name `deploi-prod`, region us-east (Ohio latency), strong DB password.
2. Project Settings → Database → Connection string → **Transaction pooler** URI → `DATABASE_URL`.
3. Project Settings → API → Project URL → `NEXT_PUBLIC_SUPABASE_URL`; anon key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`; service_role key → `SUPABASE_SERVICE_ROLE_KEY`.
4. Authentication → URL configuration: Site URL `https://app.getdeploi.com`, redirect `https://app.getdeploi.com/auth/callback`.
   Authentication → Email: enable magic link (OTP), optionally use Resend SMTP from hello@getdeploi.com.
5. Apply the schema: `DATABASE_URL=<direct connection string> npm run db:migrate` (or `supabase db push` with the CLI; the folder follows its convention).
6. Tell Postgres who is staff (used by the profile trigger):
   `alter database postgres set app.staff_emails = 'hello@getdeploi.com,<your email>';`
7. Optional demo data: `DATABASE_URL=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed`
   (creates the seeded auth users through the admin API; idempotent).
8. Storage: bucket `reports` (private) is created on first PDF upload by the service key.

## 2. Vercel project "deploi-app" (team james-ai)
1. Vercel → Add New → Project → import the `deploi-site` GitHub repository → **Root Directory: `deploi-app`** → Framework Next.js → name `deploi-app`.
2. Domains → add `app.getdeploi.com` (CNAME `app` → `cname.vercel-dns.com` at the DNS host for getdeploi.com).
3. Environment variables: every key in `.env.example`. Minimum for production:
   `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `AUTH_MODE=supabase`, `APP_SECRET`, `STAFF_EMAILS`, `NEXT_PUBLIC_APP_URL=https://app.getdeploi.com`,
   `PUBLIC_API_ALLOWED_ORIGINS=https://getdeploi.com,https://www.getdeploi.com`, `CRON_SECRET`,
   `RESEND_API_KEY`, `STAFF_NOTIFY_EMAIL`, `BOOKING_URL`.
   Twilio, Smartlead, Ollama/cloud LLM keys can be added later; adapters mock until then.
4. Crons come from `vercel.json` (hourly morning emails gated by local time; nightly workers 06:00 UTC).
   The Hobby plan allows only daily crons; use Pro or change the schedules.
5. Ollama: the `local` lane needs a reachable Ollama host (`OLLAMA_URL`). Vercel functions cannot run Ollama;
   point it at a private host (VPN/tunnel) or leave `LLM_MOCK=1` until one exists. Nothing PHI-adjacent
   ever uses a cloud provider regardless.

## 3. deploi-site (marketing)
Set `VITE_APP_API_URL=https://app.getdeploi.com`, `VITE_BOOKING_URL`, `VITE_LEGAL_ENTITY`, `VITE_LEGAL_REVIEWED`
on the existing `deploi-site` project. Note: the Vercel project currently serves `gotdeploi.com`;
`getdeploi.com` is registered on the team but not attached to the project.
