# Archiving the retired home-care consulting tables

The consulting service is gone from the code (PR #5). Its 34 tables, 8 database functions and their data are **archived, not
dropped**: moved into a separate `archive` schema that the application roles cannot read, with a dump taken first.

**Status: built and rehearsed on copies of production-shaped databases. Not run on production.** Production access is not
available to the build session, and running it needs the owner's approval (`docs/PRODUCTION-MIGRATION-PLAN.md`).

## TODO for the owner

- [ ] **Drop the archive 30 days after it is applied, if nothing broke.** The date is `archive._archive_log.archived_at + 30 days`
      (`select min(archived_at) + interval '30 days' from archive._archive_log`). `drop` refuses earlier and without `--confirm-drop`:
      `npx tsx scripts/archive-care-tables.ts drop --db <url> --confirm-drop --confirm-production=<ref>`.
      Keep the dump file for as long as your retention policy for this data requires. It is the only copy once the archive is dropped.

## What moves, and what stays

| | Moves to `archive` | Stays in `public` |
|---|---|---|
| Tables (34) | `assessments`, `trace_steps`, `clients`, `aides`, `authorizations`, `shifts`, `shift_offers`, `visits`, `evv_exceptions`, `referrals`, `applicants`, `proposed_actions`, `retention_checkins`, `worker_runs`, `evv_imports`, `assessment_credits`, `assessment_credit_applications`, `engagements`, `engagement_transitions`, `onboarding_items`, `pilots`, `pilot_measurements`, `job_runs`, `imports`, `visit_revisions`, `evv_rule_sets`, `internal_rates`, `labor_entries`, `cost_entries`, `revenue_entries`, `service_tickets`, `website_engagements`, `website_labor`, `website_transitions` | `agencies` (merchant organizations), `profiles`, `audit_events`, `prospects` and `touches` (early access applications), `invites` and `settings` (read by the sign-up trigger `handle_new_user()` and `lib/auth.ts`) |
| Functions (8) | `public_create_lead`, `public_create_lead_v2`, `website_strip_secret_keys` (the old lead intake; four of these were callable by anonymous visitors), `suppress_pending_actions`, `agency_last_worker_run`, `retire_followups_on_change`, `audit_internal_rates_row`, `engagements_status_guard` | `public_create_early_access` and every function the agent platform uses |

Tables that do not exist on the target are skipped. The tests `tests/security/care-tables.test.ts` and
`tests/security/vercel-crons.test.ts` fail if the two lists stop covering every table the consulting migrations created, if any code
reads or writes a care table or calls a consulting function, or if a consulting cron returns to `vercel.json`.

## Commands

```bash
npx tsx scripts/archive-care-tables.ts report  --db <url>                  # read only: tables, row counts, blockers
bash scripts/backup-before-launch.sh <url> <dir> --verify-into <scratch>   # full pg_dump + row counts + restore check
npx tsx scripts/archive-care-tables.ts dump    --db <url> --out <file>     # pg_dump of exactly the care tables + manifest + sha256
npx tsx scripts/archive-care-tables.ts apply   --db <url> --dump <file>    # one transaction
npx tsx scripts/archive-care-tables.ts verify  --db <url>
npx tsx scripts/archive-care-tables.ts restore --db <url>                  # undo
```

Any Supabase host needs `--confirm-production=<project-ref>`; the target is never read from the environment.

## What `apply` does, and what it refuses

1. Refuses unless the dump's sha256 matches its record and its row-count manifest equals the live counts (a table changed since
   the dump means a new dump).
2. Refuses if anything we keep depends on what would move: a foreign key from a kept table, a view, a policy, a trigger, or a
   function not on the consulting list that mentions a care table. `report` shows the same check without changing anything.
3. In **one transaction**: records each table's grants, moves it (`alter table ... set schema archive`), records and moves the 8
   functions, revokes everything on the schema from `public`, `anon`, `authenticated` and `service_role`, then checks that every
   archived table has the same row count as before and that nothing is left in `public`. Any mismatch rolls the whole thing back.
4. Writes `archive._archive_log` (table, rows, time, dump sha256), `archive._archive_grants` and `archive._archive_functions`,
   which `restore` uses to put everything back with the same rights.

Rows, indexes, constraints, triggers and policies move with their table. Nothing is deleted.

**The retired migrations.** `scripts/migrate.ts` now skips the consulting-only migrations `20261021000022` to `027`
(`scripts/retired-migrations.ts`) on any database that has not already applied them. Without that, a normal migrate run (or
`npm run db:migrate:prod`, or the test helper) would build more consulting tables, and would fail after the archive.

## Rehearsal results (local copies; no production data)

`bash scripts/test-archive-care-tables.sh 021` and `... 027`. Synthetic rows were generated in every table that accepts them.

| Check | Shape 021 (production as its logs show it) | Shape 027 (full consulting schema) |
|---|---|---|
| Care tables present / archived | 22 of 34 | 34 of 34 |
| Rows before, in archive | 40, 40 | 63, 63 |
| Functions archived | 2 | 8 |
| Kept rows (agencies / prospects / profiles) before, after | 2/0/0, 2/0/0 | 2/0/0, 2/0/0 |
| Dump restored into a scratch DB, row counts equal the manifest | 22 tables | 34 tables |
| `anon`, `authenticated`, `service_role` read the archive | permission denied, all three | permission denied, all three |
| Anonymous-callable consulting functions after archiving | 0 | 0 |
| Merchant, platform and early access tests on the archived copy | 42 passed + 4 passed | 42 passed + 4 passed |
| `drop` inside 30 days, and without `--confirm-drop` | refused | refused |
| `restore`: rows, table grants and function rights identical to before | yes (fingerprints equal) | yes (fingerprints equal) |
| Re-apply after restore | ok | ok |

Not covered: real production data, Supabase-specific roles beyond the three above, and PostgREST schema exposure settings (the
`archive` schema is not exposed by default; confirm under Supabase → API settings → Exposed schemas).
