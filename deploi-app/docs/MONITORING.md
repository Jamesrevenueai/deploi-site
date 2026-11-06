# Monitoring

Production app: `https://app.getdeploi.com` (replace with the preview URL when checking a preview). Nothing in this
document is live yet: every external step below needs an account the owner holds.

## 1. Uptime checks (exact URLs)

| Check | URL | Method | Interval | Pass when | Alert |
|---|---|---|---|---|---|
| Health | `https://app.getdeploi.com/api/health` | GET | 5 min | HTTP 200 and JSON `ok == true` | 2 consecutive failures (warn), 3 (page) |
| Health: backlog | same | GET | 5 min | `queue.oldestDueAgeSec < 7200` | page |
| Health: dead jobs | same | GET | 5 min | `queue.dead == 0` | warn |
| Health: retention | same | GET | 5 min | `retention.lagHours < 54` | page |
| Health: deletions | same | GET | 5 min | `deletion.failed == 0` | page |
| Login page | `https://app.getdeploi.com/login` | GET | 5 min | HTTP 200, body contains `Sign in` | 3 consecutive failures (page) |
| Cron refusal | `https://app.getdeploi.com/api/cron/jobs` | GET (no auth header) | 60 min | HTTP 401 | any other status (page: the cron secret is not enforced) |

Most uptime tools (Vercel Monitoring, Better Stack, UptimeRobot) can assert on a JSON field; set the assertions
above on the health URL. Never put `CRON_SECRET` in an uptime tool: the cron refusal check proves it is required.

**Smoke check after every deploy** (read-only: five GETs, no cookies, no secrets):

```
npx tsx scripts/smoke-check.ts https://app.getdeploi.com
```

It checks: health (200, `ok: true`), the auth redirect (`/store` without a session goes to `/login`), a public page
(`/login` is HTML), the CSP header (a `script-src` nonce on `/login`), and the cron refusal (`/api/cron/jobs` answers
401 without the secret). Exit code 0 when all pass.

## 2. Log drain (Vercel)

The app writes one JSON line per event (`lib/log.ts`): `{"t": ..., "level": "info|warn|error", "msg": "<event>", ...}`.
Personal details are redacted by key name before the line is written; ids, counts and outcomes stay.

1. Vercel → Project `deploi-app` → **Settings → Log Drains** → **Add Log Drain**.
2. Choose the destination integration (Better Stack, Datadog, Axiom ...) or **Custom endpoint** (HTTPS, JSON or NDJSON).
3. Sources: **Serverless Functions** and **Edge Functions** (the middleware); environments: **Production** (add
   Preview separately if wanted). Sampling: 100%.
4. Copy the drain's verification header or secret into the destination as it asks; save. Vercel sends a test event.
5. In the log tool, create the alerts below on the `msg` field (and `level`).

| Log event (`msg`) | Warn | Page |
|---|---|---|
| `health.db_unreachable` | 1 | 3 in 10 min |
| `cron.jobs.failed`, `cron.alerts.failed`, `cron.retention.failed`, `cron.health.failed` | 1 | 3 in a row |
| `jobs.attempt_failed` | > 20 in 10 min | > 100 in 10 min |
| `job.dead` (operational log) | 1 | > 10 in an hour |
| `ai.provider_error` | > 5 in an hour | > 20% of calls |
| `ops.alert_rule_failed` | 1 | 3 in a row |
| `org.deletion_failed` | 1 | - |
| `store.api.failed` | > 10 in 10 min | > 50 in 10 min |

Operational logs are also stored (table `ops_logs`, 30 days, `OPS_LOG_RETENTION_DAYS`) and queryable by staff at
`/staff/ops` by organization, job id, case reference (`DC-...`) or correlation id, merged with case history.

## 3. Scheduled jobs (vercel.json)

| Cron | Schedule (UTC) | What |
|---|---|---|
| `/api/cron/agents` | `7 * * * *` | due agent runs and queued email onto the durable queue, then work it |
| `/api/cron/jobs` | `41 * * * *` | the job worker (also queues retention, deletions, case checks and the alert evaluation) |
| `/api/cron/office` | `*/15 * * * *` | the Office scheduler |
| `/api/cron/library` | `23 * * * *` | library agents |
| `/api/cron/weekly-summary` | `13 13 * * 1` | the weekly summary |
| `/api/cron/alerts` | `*/10 * * * *` | the alert evaluation (`ops.alerts`) |
| `/api/cron/retention` | `17 4 * * *` | the daily retention pass and due organization deletions |
| `/api/cron/health` | `29 * * * *` | a health snapshot into the operational log and the `cron.health` heartbeat |
| `/api/cron/daily-report` | `11 12 * * *` | the morning report to each organization's owners and admins (`notify.morning`, once per organization per day; heartbeat `cron.daily-report`) |

Every cron needs `Authorization: Bearer $CRON_SECRET` (Vercel sends it when `CRON_SECRET` is set on the project).
Failed invocations appear under the project's **Cron Jobs** tab; the heartbeats below are the cross-check.

## 4. Alerts raised by the app (`lib/ops/alerts.ts`)

Evaluated every 10 minutes as a durable job. One live alert per rule and subject (seen again: updated, not
duplicated); resolved automatically when the condition clears. Staff (`STAFF_EMAILS`) are told about every alert;
the organization's owners are told about alerts on their organization, in plain words without internal detail.
Notices go through `lib/ops/notify.ts` (the system mailer is wired at integration; until then each notice is a log
line `ops.alert_notice` and the alert records that nobody was emailed). Staff acknowledge alerts at `/staff/ops`.

| Rule | Fires when (default) | Severity | Setting |
|---|---|---|---|
| `jobs.dead` | any dead job | warn; page above 10 | `OPS_DEAD_JOBS_PAGE` |
| `queue.age` | oldest due job older than 1800 s | warn; page at 4x | `OPS_QUEUE_AGE_SEC` (1800) |
| `cron.missing` | heartbeat missing, failed, or older than: `cron.jobs` 2 h, `cron.agents` 2 h, `cron.alerts` 1 h, `cron.health` 2 h, `platform.retention` 30 h | warn; page at 2x, never ran or failed | - |
| `org.case_failures` | an organization's cases moved to failed or escalated more than 5 times in 24 h | warn; page at 3x | `OPS_ORG_CASE_FAILURES_24H` (5) |
| `case.deadline` | an open case past its deadline | warn | - |
| `connection.health` | the latest `connection_health` row of a connection is `needs_reauth` or `error` (only when that table exists) | warn | - |
| `ai.spend` | this month's model spend at 80% of the organization's AI budget | warn; page at 100% | `OPS_AI_SPEND_RATIO` (0.8) |
| `email.bounce_rate` | bounces + complaints over sent, 7 days, above 5% with at least 20 sent | warn; page at 2x | `OPS_BOUNCE_RATE` (0.05), `OPS_BOUNCE_MIN_SENT` (20) |
| `execution.unknown` | at least 3 outcomes in 24 h Deploi could not confirm (store writes, Office actions, emails) | warn; page at 3x | `OPS_UNKNOWN_24H` (3) |

## 5. Health endpoint fields

`GET /api/health` (public, no tenant data: counts, ages and times only). `ok: false` with HTTP 503 when the database is
unreachable.

- `db.reachable`, `db.latencyMs` (warn > 500, page > 2000)
- `queue.depth`, `queue.due`, `queue.running`, `queue.dead`, `queue.expiredLeases`, `queue.oldestDueAgeSec`
- `crons.<job>.lastRunAt` / `.status` (`cron.jobs`, `cron.agents`, `cron.alerts`, `cron.health`, `ops.alerts`, `platform.retention`, ...)
- `ai.provider` (off | http | fake), `ai.configured`, `ai.problems`, `ai.lastHour.calls`, `ai.lastHour.providerErrors`,
  `ai.lastHour.refused`, `ai.stalePending` (warn > 0, page > 10)
- `retention.lastRunAt`, `retention.status`, `retention.lagHours` (warn > 30, page > 54)
- `deletion.overdue`, `deletion.failed`, `deletion.oldestOverdueHours` (page > 24)
- `paused.jobs` (`JOBS_PAUSED=on`), `paused.liveWrites` (`LIVE_WRITES=off`)

The AI gateway enforces its own budgets and runaway caps before every call, so a cost alert is a pricing signal, not
an emergency: refusals (`ai.lastHour.refused`) mean the guard worked, and AI-assisted steps fall back to their rules.

## 6. Incident switches

Shown with these instructions on `/staff/ops`.

- **Stop every worker:** Vercel → Project → Settings → Environment Variables → `JOBS_PAUSED=on` (Production) → Redeploy.
  Queued work waits; nothing is lost. Turn it off the same way.
- **Block every store write:** `LIVE_WRITES=off` (Production) → Redeploy. Approved changes wait.
- **One organization:** staff can stop all of its agents on the customer's behalf at `/staff/ops` (audited). Turning
  the stop off restarts nothing: the customer resumes each agent. Staff never approve, grant or resume.

## 7. Other places to watch (owner)

1. **Supabase**: enable usage and disk alerts (Settings → Billing / Database) and confirm PITR (docs/BACKUP-RESTORE.md).
2. **Stripe**: webhook failure e-mails are on by default for the account owner; keep them on.
3. **Staff pages**: `/staff/ops` (queue, alerts, organizations, cases, logs), `/staff/unit-economics` (cost flags,
   weekly), `/staff/audit`.
