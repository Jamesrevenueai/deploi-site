# Monitoring

## What exists in the app (configured)

- **`GET /api/health`** (public, no tenant data: counts, ages and times only). `ok: false` with HTTP 503 when the
  database is unreachable. Fields:
  - `db.reachable`, `db.latencyMs`
  - `queue.depth`, `queue.due`, `queue.running`, `queue.dead`, `queue.expiredLeases`, `queue.oldestDueAgeSec`
  - `crons.<job>.lastRunAt` / `.status` (heartbeats of `cron.jobs`, `cron.agents`, `cron.library`, `cron.office`,
    `platform.retention`, ...)
  - `ai.provider` (off | http | fake), `ai.configured`, `ai.problems` (count of configuration problems),
    `ai.lastHour.calls`, `ai.lastHour.providerErrors`, `ai.lastHour.refused`, `ai.stalePending` (calls reserved
    more than 5 minutes ago that never finished)
  - `retention.lastRunAt`, `retention.status`, `retention.lagHours`
  - `deletion.overdue` (deletions past their cooling-off period not yet done), `deletion.failed`,
    `deletion.oldestOverdueHours`
  - `paused.jobs` (`JOBS_PAUSED=on`), `paused.liveWrites` (`LIVE_WRITES=off`)
- **Structured logs** (`lib/log.ts`): one JSON line per event, personal details redacted by key name. Events to
  alert on: `health.db_unreachable`, `cron.jobs.failed`, `jobs.attempt_failed`, `ai.provider_error`,
  `org.deletion_failed`, `store.api.failed`.
- **Staff pages:** `/staff/unit-economics` (per-organization variable cost against the $15-$40 target for a $249
  plan, flags), `/staff/audit`.

## Alert thresholds

| Signal | Warn | Page | Source |
|---|---|---|---|
| Health endpoint | 1 failed check | 3 consecutive failures (5-minute interval) or `ok: false` | uptime check on `/api/health` |
| DB latency | `db.latencyMs` > 500 | > 2000 | `/api/health` |
| Queue backlog | `queue.oldestDueAgeSec` > 1800 | > 7200 | `/api/health` |
| Dead jobs | `queue.dead` grows | +10 in an hour | `/api/health` |
| Job worker | `crons["cron.jobs"].lastRunAt` older than 2 h | older than 4 h | `/api/health` |
| Retention | `retention.lagHours` > 30 | > 54 (two missed days) or `status` failed | `/api/health` |
| Deletion | `deletion.overdue` > 0 for 2 h | `deletion.failed` > 0 or `oldestOverdueHours` > 24 | `/api/health`, log `org.deletion_failed` |
| AI provider errors | `ai.lastHour.providerErrors` > 5 | > 20% of `ai.lastHour.calls` | `/api/health`, log `ai.provider_error` |
| AI stuck reservations | `ai.stalePending` > 0 | > 10 | `/api/health` |
| AI configuration | `ai.provider` is not `off` and `ai.configured` is false | - | `/api/health` |
| AI cost | an organization flagged `above_target` on `/staff/unit-economics` | flagged `negative_margin` | staff page (weekly review) |
| Errors | `store.api.failed` > 10 in 10 min | > 50 in 10 min | log drain |

The AI gateway enforces its own budgets and runaway caps before every call, so a cost alert is a pricing signal,
not an emergency: refusals (`ai.lastHour.refused`) mean the guard worked.

## Where to wire them (needs the owner)

Nothing below is configured from this repository; each needs an account the owner holds.

1. **Uptime check** (Vercel Monitoring, Better Stack, UptimeRobot or similar): `GET https://<app>/api/health`
   every 5 minutes, alert on non-200 or on the JSON thresholds above (most uptime tools can assert on a JSON
   field: `ok == true`, `queue.oldestDueAgeSec < 7200`, `retention.lagHours < 54`, `deletion.failed == 0`).
2. **Vercel log drain** (Project -> Settings -> Log Drains) to the log tool of choice; create alerts on the event
   names above (`msg` field of each JSON line).
3. **Vercel cron monitoring**: the crons are in `vercel.json`; Vercel shows failed invocations under the
   project's Cron Jobs tab. The heartbeat fields in `/api/health` are the cross-check.
4. **Supabase**: enable the project's usage and disk alerts (Settings -> Billing / Database), and confirm PITR
   (docs/BACKUP-RESTORE.md).
5. **Stripe**: webhook failure e-mails are on by default for the account owner; keep them on.
