# Working on a section (4–8)

- Query as the user: `withUser(session, db => ...)` from `lib/db.ts`. Use `admin()` only in workers/cron.
- Audit reads of client-side data with `db.auditRead(table, agencyId, rowIds)`.
- Migrations are additive files in `supabase/migrations/2026102000000N_<section>.sql`
  (`alter table ... add column if not exists`, `create table if not exists`). Re-run `npm run db:migrate`.
- UI: `components/ui/*` (Button, ImageCard, Tile, GlassPill, PageHeader, Banner, Field, Badge, Empty, Sheet, Icon).
  Left-aligned, one-handed at 390px, exactly one primary button per viewport.
- Email/SMS: `lib/adapters/{email,sms}.ts` (mock when env empty). LLM: `lib/llm` lanes; anything that
  could see client records goes through `lib/phi` (local only).
- Logging: `lib/log.ts` only. Never log names, emails, phones, notes.
- Cron endpoints live under `app/api/cron/*` and verify `Authorization: Bearer ${CRON_SECRET}` (skip when unset in dev).
