/**
 * Failure alerts. `evaluateAlerts()` runs every 10 minutes as the durable job `ops.alerts` (queued by the
 * cron /api/cron/alerts and by every /api/cron/jobs sweep with a ten-minute idempotency key).
 *
 * Each rule returns what is firing now, one entry per subject. For every rule that evaluated:
 *   - a firing subject without a live alert opens one (deduplicated: one live alert per rule + subject;
 *     the database refuses a second) and notifies staff, plus the organization's owners for organization alerts;
 *   - a firing subject with a live alert updates it (last seen, occurrences, detail); no new notice;
 *   - a live alert whose subject no longer fires is resolved automatically, and the same people are told.
 * A rule that fails to evaluate leaves its alerts as they are (never resolved by an error).
 * Acknowledging (staff, lib/ops/staff.ts) keeps the alert live but marks that someone is on it.
 *
 * Rules and thresholds (environment, defaults in brackets; docs/MONITORING.md lists them):
 *   jobs.dead            dead jobs > 0                                   (page when > OPS_DEAD_JOBS_PAGE [10])
 *   queue.age            oldest due job older than OPS_QUEUE_AGE_SEC [1800] (page at 4x)
 *   cron.missing         a heartbeat older than its limit, never recorded, or failed: cron.jobs [2h], cron.agents [2h], cron.alerts [1h],
 *                        cron.health [2h], platform.retention [30h]
 *   org.case_failures    an organization's cases moved to failed or escalated more than OPS_ORG_CASE_FAILURES_24H [5] times in 24h
 *   case.deadline        an open case past its deadline
 *   connection.health    the latest connection_health row for a connection is needs_reauth or error
 *   ai.spend             this month's model spend at or above OPS_AI_SPEND_RATIO [0.8] of the organization's budget (page at 100%)
 *   email.bounce_rate    bounces + complaints / sent over 7 days above OPS_BOUNCE_RATE [0.05], with at least OPS_BOUNCE_MIN_SENT [20] sent
 *   execution.unknown    at least OPS_UNKNOWN_24H [3] outcomes in 24h that Deploi cannot confirm (store writes, Office actions, emails)
 */
import { admin, type Db } from '../db'
import { queueStats } from '../jobs/queue'
import { aiBudgets } from '../ai/budgets'
import { monthOf } from '../ai/meter'
import { log } from '../log'
import { opsNotifier, ownerRecipients, staffRecipients, type OpsNotice } from './notify'
import { writeOpsLog } from './logs'

const INTEGRATION_LABEL: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', hubspot: 'HubSpot', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks', agent_mailbox: 'agent mailbox', gmail: 'Gmail', microsoft: 'Microsoft 365', stripe: 'Stripe' }

export const ALERT_RULES = ['jobs.dead', 'queue.age', 'cron.missing', 'org.case_failures', 'case.deadline', 'connection.health', 'ai.spend', 'email.bounce_rate', 'execution.unknown'] as const
export type AlertRule = (typeof ALERT_RULES)[number]
export type Severity = 'warn' | 'page'
export type Firing = {
  rule: AlertRule; subject: string; orgId: string | null; severity: Severity; title: string
  /** what the organization's owner is told (organization alerts only); never internal detail */
  ownerText?: string
  detail: Record<string, unknown>
}
export type AlertRow = {
  id: string; org_id: string | null; rule: string; subject: string; severity: Severity; status: 'open' | 'acknowledged' | 'resolved'; title: string; detail: Record<string, unknown>
  occurrences: number; first_seen_at: string; last_seen_at: string; acknowledged_by: string | null; acknowledged_at: string | null; resolved_at: string | null; resolved_reason: string | null
  notified: unknown[]
}

const num = (k: string, d: number, min = 0) => { const v = Number((process.env[k] ?? '').trim()); return (process.env[k] ?? '').trim() !== '' && Number.isFinite(v) && v >= min ? v : d }
export const alertThresholds = () => ({
  deadJobsPage: num('OPS_DEAD_JOBS_PAGE', 10, 1),
  queueAgeSec: num('OPS_QUEUE_AGE_SEC', 1800, 60),
  orgCaseFailures24h: num('OPS_ORG_CASE_FAILURES_24H', 5, 1),
  aiSpendRatio: Math.min(num('OPS_AI_SPEND_RATIO', 0.8, 0.05), 1),
  bounceRate: Math.min(num('OPS_BOUNCE_RATE', 0.05, 0.001), 1),
  bounceMinSent: num('OPS_BOUNCE_MIN_SENT', 20, 1),
  unknown24h: num('OPS_UNKNOWN_24H', 3, 1),
  crons: { 'cron.jobs': 2 * 3600, 'cron.agents': 2 * 3600, 'cron.alerts': 3600, 'cron.health': 2 * 3600, 'platform.retention': 30 * 3600 } as Record<string, number>,
})

type RuleFn = (db: Db, now: Date) => Promise<Firing[]>
const iso = (d: Date) => d.toISOString()
const hours = (s: number) => Math.round(s / 360) / 10

const RULES: Record<AlertRule, RuleFn> = {
  async 'jobs.dead'(db) {
    const r = await db.query<{ kind: string; n: number }>(`select kind, count(*)::int as n from jobs where status = 'dead' group by kind order by n desc`)
    const total = r.reduce((s, x) => s + x.n, 0)
    if (!total) return []
    return [{ rule: 'jobs.dead', subject: 'all', orgId: null, severity: total > alertThresholds().deadJobsPage ? 'page' : 'warn', title: `${total} dead job${total === 1 ? '' : 's'} on the queue`, detail: { dead: total, kinds: Object.fromEntries(r.slice(0, 10).map(x => [x.kind, x.n])) } }]
  },
  async 'queue.age'(db, now) {
    const q = await queueStats(db, now), t = alertThresholds().queueAgeSec
    if (q.oldestDueAgeSec <= t) return []
    return [{ rule: 'queue.age', subject: 'all', orgId: null, severity: q.oldestDueAgeSec > 4 * t ? 'page' : 'warn', title: `The oldest due job has waited ${Math.round(q.oldestDueAgeSec / 60)} minutes`, detail: { oldest_due_age_sec: q.oldestDueAgeSec, due: q.due, running: q.running, threshold_sec: t } }]
  },
  async 'cron.missing'(db, now) {
    const rows = await db.query<{ job_key: string; last_run_at: string; last_status: string }>('select job_key, last_run_at, last_status from cron_heartbeats')
    const out: Firing[] = []
    for (const [key, max] of Object.entries(alertThresholds().crons)) {
      const h = rows.find(r => r.job_key === key)
      const age = h ? Math.round((now.getTime() - new Date(h.last_run_at).getTime()) / 1000) : null
      if (h && age! <= max && h.last_status !== 'failed') continue
      const why = !h ? 'has never run' : h.last_status === 'failed' ? 'failed on its last run' : `last ran ${hours(age!)} h ago (limit ${hours(max)} h)`
      out.push({ rule: 'cron.missing', subject: key, orgId: null, severity: !h || age! > 2 * max || h.last_status === 'failed' ? 'page' : 'warn', title: `Scheduled job ${key} ${why}`, detail: { job_key: key, age_sec: age, limit_sec: max, last_status: h?.last_status ?? null } })
    }
    return out
  },
  async 'org.case_failures'(db, now) {
    const n = alertThresholds().orgCaseFailures24h
    const r = await db.query<{ org_id: string; n: number; failed: number; escalated: number }>(
      `select org_id, count(*)::int as n, count(*) filter (where to_status = 'failed')::int as failed, count(*) filter (where to_status = 'escalated')::int as escalated
       from case_events where to_status in ('failed','escalated') and at > $1 group by org_id having count(*) > $2`, [iso(new Date(now.getTime() - 864e5)), n])
    return r.map(x => ({ rule: 'org.case_failures' as const, subject: x.org_id, orgId: x.org_id, severity: x.n > 3 * n ? 'page' as const : 'warn' as const,
      title: `${x.n} cases failed or were escalated in 24 hours`, ownerText: `${x.n} pieces of work your AI team was handling failed or need you (in the last 24 hours). Open "Needs my approval" and "Work in progress" to see them.`,
      detail: { in_24h: x.n, failed: x.failed, escalated: x.escalated, threshold: n } }))
  },
  async 'case.deadline'(db, now) {
    const r = await db.query<{ id: string; org_id: string; ref: string; status: string; deadline_at: string }>(
      `select id, org_id, ref, status, deadline_at from cases where deadline_at < $1 and status not in ('resolved','cancelled') order by deadline_at limit 500`, [iso(now)])
    return r.map(c => ({ rule: 'case.deadline' as const, subject: c.id, orgId: c.org_id, severity: 'warn' as const, title: `Case ${c.ref} is past its deadline (${iso(new Date(c.deadline_at)).slice(0, 16).replace('T', ' ')} UTC)`,
      ownerText: `Case ${c.ref} passed its deadline and is still ${c.status.replace('_', ' ')}.`, detail: { case_ref: c.ref, status: c.status, deadline_at: iso(new Date(c.deadline_at)) } }))
  },
  async 'connection.health'(db) {
    // the latest health check per connection (connection_health, migration 20261106000055, written by lib/integrations/health.ts)
    const r = await db.query<{ org_id: string; connection_id: string; integration: string; status: string; previous_status: string | null }>(
      `select distinct on (org_id, connection_id) org_id::text, connection_id::text, integration, status, previous_status
       from connection_health order by org_id, connection_id, checked_at desc, id desc`)
    return r.filter(x => ['needs_reauth', 'error'].includes(x.status)).map(x => {
      const name = INTEGRATION_LABEL[x.integration] ?? x.integration
      return {
        rule: 'connection.health' as const, subject: `${x.org_id}:${x.connection_id}`.slice(0, 200), orgId: x.org_id, severity: 'warn' as const,
        title: `A ${name} connection is ${x.status === 'needs_reauth' ? 'asking to be reconnected' : 'failing'}${x.previous_status ? ` (was ${x.previous_status.replace('_', ' ')})` : ''}`,
        ownerText: x.status === 'needs_reauth' ? `Your ${name} connection needs to be reconnected; agents that use it are waiting. Open Integrations to reconnect it.` : `Your ${name} connection is failing; agents that use it are waiting. Open Integrations to check it.`,
        detail: { status: x.status, previous_status: x.previous_status, integration: x.integration },
      }
    })
  },
  async 'ai.spend'(db, now) {
    const month = monthOf(now), ratio = alertThresholds().aiSpendRatio
    const r = await db.query<{ org_id: string; spent: string }>(`select org_id, sum(cost_usd)::text as spent from ai_usage where created_at >= $1::date and outcome <> 'refused' group by org_id having sum(cost_usd) > 0`, [month])
    const out: Firing[] = []
    for (const x of r) {
      const b = await aiBudgets(db, x.org_id, '', now)
      const spent = Number(x.spent)
      if (!(b.orgUsd > 0) || spent < ratio * b.orgUsd) continue
      const pct = Math.round((spent / b.orgUsd) * 100)
      out.push({ rule: 'ai.spend', subject: `${x.org_id}:${month.slice(0, 7)}`, orgId: x.org_id, severity: spent >= b.orgUsd ? 'page' : 'warn', title: `AI spend at ${pct}% of the monthly budget`,
        ownerText: `Your AI team has used ${pct}% of this month's AI budget. When it is used up, AI-assisted steps fall back to the standard rules until next month.`, detail: { spent_usd: Math.round(spent * 1e4) / 1e4, budget_usd: b.orgUsd, ratio, month: month.slice(0, 7) } })
    }
    return out
  },
  async 'email.bounce_rate'(db, now) {
    const t = alertThresholds(), since = iso(new Date(now.getTime() - 7 * 864e5))
    const r = await db.query<{ org_id: string; sent: number; bad: number }>(
      `with s as (select org_id, count(*)::int as sent from email_messages where status in ('accepted','delivery_unknown') and created_at > $1 group by org_id),
            b as (select org_id, count(*)::int as bad from email_suppressions where reason in ('bounced','complained') and created_at > $1 group by org_id)
       select s.org_id, s.sent, coalesce(b.bad, 0) as bad from s left join b on b.org_id = s.org_id where s.sent >= $2`, [since, t.bounceMinSent])
    return r.filter(x => x.bad / x.sent > t.bounceRate).map(x => ({ rule: 'email.bounce_rate' as const, subject: x.org_id, orgId: x.org_id, severity: x.bad / x.sent > 2 * t.bounceRate ? 'page' as const : 'warn' as const,
      title: `Email bounce and complaint rate ${(100 * x.bad / x.sent).toFixed(1)}% over 7 days`, ownerText: `More of your AI team's emails are bouncing or being marked as spam than is safe (${(100 * x.bad / x.sent).toFixed(1)}% in 7 days). Check the addresses your agents write to.`,
      detail: { sent_7d: x.sent, bounced_or_complained_7d: x.bad, rate: Math.round((x.bad / x.sent) * 1e4) / 1e4, threshold: t.bounceRate } }))
  },
  async 'execution.unknown'(db, now) {
    const n = alertThresholds().unknown24h, since = iso(new Date(now.getTime() - 864e5))
    const r = await db.query<{ org_id: string; store: number; office: number; email: number }>(
      `select org_id, sum(store)::int as store, sum(office)::int as office, sum(email)::int as email from (
         select org_id, 1 as store, 0 as office, 0 as email from executions where status = 'unknown' and coalesce(finished_at, started_at) > $1
         union all select org_id, 0, 1, 0 from office_actions where status = 'unknown' and updated_at > $1
         union all select org_id, 0, 0, 1 from email_messages where status = 'delivery_unknown' and updated_at > $1) u
       group by org_id having count(*) >= $2`, [since, n])
    return r.map(x => { const total = x.store + x.office + x.email; return { rule: 'execution.unknown' as const, subject: x.org_id, orgId: x.org_id, severity: total >= 3 * n ? 'page' as const : 'warn' as const,
      title: `${total} outcomes in 24 hours could not be confirmed`, ownerText: `${total} actions in the last day could not be confirmed (for example a store change or an email interrupted mid-way). Nothing is repeated automatically; each one shows "unknown" with a retry that checks first.`,
      detail: { store_writes: x.store, office_actions: x.office, emails: x.email, threshold: n } } })
  },
}

/** What every rule finds firing now (rules that fail are reported in `errors` and skipped). */
export async function fireAll(now = new Date(), rules: readonly AlertRule[] = ALERT_RULES): Promise<{ firing: Firing[]; evaluated: AlertRule[]; errors: Record<string, string> }> {
  const firing: Firing[] = [], evaluated: AlertRule[] = [], errors: Record<string, string> = {}
  for (const rule of rules) {
    try { firing.push(...(await admin(db => RULES[rule](db, now)))); evaluated.push(rule) }
    catch (e) { errors[rule] = (e as Error).message.slice(0, 200); log.error('ops.alert_rule_failed', { rule, error: errors[rule] }) }
  }
  return { firing, evaluated, errors }
}

async function notify(a: AlertRow, f: Pick<Firing, 'ownerText'> | null, event: 'opened' | 'resolved'): Promise<unknown[]> {
  const notices: OpsNotice[] = []
  const staff = staffRecipients()
  const verb = event === 'opened' ? 'Alert' : 'Resolved'
  if (staff.length) notices.push({ audience: 'staff', to: staff, alertId: a.id, event, subject: `[Deploi ${verb}${a.severity === 'page' ? ' · page' : ''}] ${a.title}`.slice(0, 200),
    text: [`${verb}: ${a.title}`, `Rule: ${a.rule}  Subject: ${a.subject}${a.org_id ? `  Organization: ${a.org_id}` : ''}`, `First seen ${a.first_seen_at}`, 'Staff console: /staff/ops'].join('\n') })
  if (a.org_id) {
    const owners = await admin(db => ownerRecipients(db, a.org_id!))
    const text = event === 'opened' ? (f?.ownerText ?? a.title) : `This has cleared: ${a.title}.`
    if (owners.length) notices.push({ audience: 'owner', to: owners, alertId: a.id, event, subject: event === 'opened' ? `Deploi: ${a.title}`.slice(0, 200) : `Deploi: cleared — ${a.title}`.slice(0, 200), text })
  }
  const out: unknown[] = []
  for (const n of notices) {
    let r: { ok: boolean; reason?: string }
    try { r = await opsNotifier().send(n) } catch (e) { r = { ok: false, reason: (e as Error).message.slice(0, 200) } }
    out.push({ audience: n.audience, event, count: n.to.length, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), at: new Date().toISOString() })
  }
  return out
}

export type EvaluateResult = { opened: string[]; updated: string[]; resolved: string[]; errors: Record<string, string> }

/** One evaluation: open, refresh and resolve alerts. Safe to run concurrently (the unique live index decides). */
export async function evaluateAlerts(opts: { now?: Date; rules?: readonly AlertRule[] } = {}): Promise<EvaluateResult> {
  const now = opts.now ?? new Date()
  const { firing, evaluated, errors } = await fireAll(now, opts.rules ?? ALERT_RULES)
  const out: EvaluateResult = { opened: [], updated: [], resolved: [], errors }
  const seen = new Set<string>()
  for (const f of firing) {
    const k = `${f.rule}|${f.subject}`
    if (seen.has(k)) continue
    seen.add(k)
    const r = await admin(async db => {
      const ins = await db.one<AlertRow>(`insert into alerts (org_id, rule, subject, severity, title, detail, first_seen_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$7)
        on conflict (rule, subject) where status <> 'resolved' do nothing returning *`, [f.orgId, f.rule, f.subject.slice(0, 200), f.severity, f.title.slice(0, 300), JSON.stringify(f.detail), iso(now)])
      if (ins) return { row: ins, created: true }
      const up = await db.one<AlertRow>(`update alerts set last_seen_at = greatest(last_seen_at, $3), occurrences = occurrences + 1, detail = $4, title = $5,
          severity = case when $6 = 'page' then 'page' else severity end, updated_at = now() where rule = $1 and subject = $2 and status <> 'resolved' returning *`,
        [f.rule, f.subject.slice(0, 200), iso(now), JSON.stringify(f.detail), f.title.slice(0, 300), f.severity])
      return { row: up!, created: false }
    })
    if (r.created) {
      out.opened.push(r.row.id)
      const n = await notify(r.row, f, 'opened')
      await admin(db => db.query(`update alerts set notified = notified || $2::jsonb where id = $1`, [r.row.id, JSON.stringify(n)]))
      await writeOpsLog({ level: r.row.severity === 'page' ? 'error' : 'warn', event: 'alert.opened', orgId: r.row.org_id, correlationId: r.row.id, summary: r.row.title, detail: { rule: f.rule } })
    } else out.updated.push(r.row.id)
  }
  // auto-resolve: live alerts of rules that evaluated whose subject no longer fires
  if (evaluated.length) {
    const resolved = await admin(db => db.query<AlertRow>(
      `update alerts set status = 'resolved', resolved_at = $3, resolved_reason = 'the condition cleared', updated_at = now()
       where status <> 'resolved' and rule = any($1::text[]) and not ((rule || '|' || subject) = any($2::text[])) returning *`, [evaluated, [...seen], iso(now)]))
    for (const a of resolved) {
      out.resolved.push(a.id)
      const n = await notify(a, null, 'resolved')
      await admin(db => db.query(`update alerts set notified = notified || $2::jsonb where id = $1`, [a.id, JSON.stringify(n)]))
      await writeOpsLog({ event: 'alert.resolved', orgId: a.org_id, correlationId: a.id, summary: a.title, detail: { rule: a.rule } })
    }
  }
  return out
}

export async function listAlerts(db: Db, f: { status?: 'live' | 'resolved' | 'all'; orgId?: string; limit?: number } = {}): Promise<AlertRow[]> {
  const where = [f.status === 'resolved' ? `status = 'resolved'` : f.status === 'all' ? 'true' : `status <> 'resolved'`]
  const params: unknown[] = []
  if (f.orgId) { params.push(f.orgId); where.push(`org_id = $${params.length}`) }
  params.push(Math.min(Math.max(f.limit ?? 100, 1), 500))
  return db.query<AlertRow>(`select * from alerts where ${where.join(' and ')} order by (status = 'resolved'), case severity when 'page' then 0 else 1 end, last_seen_at desc limit $${params.length}`, params)
}
