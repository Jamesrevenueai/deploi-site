/**
 * The morning report: one email per organization per day to its owners and admins (email on), saying what the
 * agents did since the last report (owner updates, verified case resolutions, crew jobs done), the time and
 * money saved (labelled estimates, with the formula), and what is not finished and why (blocked, failed or
 * waiting cases, and what waits for the owner's decision).
 *
 *  - Job kind notify.morning (one per organization per UTC day: idempotency key morning@<date>), queued by the
 *    daily cron /api/cron/daily-report and run there; the hourly job worker also runs any left over.
 *  - Idempotent: morning_reports has one row per (organization, date); a second run for the day sends nothing.
 *    Each email also carries its own system-mailer key, so a retried job cannot send twice.
 *  - Sent through the system mailer: held unless EMAIL_LIVE_SENDS allows the recipient.
 */
import { admin, type Db } from '../db'
import { env } from '../env'
import { log } from '../log'
import { sendSystemEmail } from '../email/system'
import { enqueue, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { weeklyFacts, weekStartOf } from '../agents/weekly'
import { updateRecipients } from './preferences'
import { safePath, type MorningData } from './templates'

/** Minutes of owner work one handled item replaces, and the hourly value of that time. Shown with every estimate. */
export const MORNING_MINUTES = { update: 6, resolvedCase: 10, crewJobDone: 3 } as const
export const hourlyUsd = () => { const v = Number(process.env.MORNING_HOURLY_USD); return Number.isFinite(v) && v > 0 && v < 1000 ? v : 30 }

const dayOf = (now: Date) => now.toISOString().slice(0, 10)
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })

const UNFINISHED_WHY: Record<string, string> = {
  blocked: 'the agent could not finish on its own', failed: 'the last attempt failed', escalated: 'handed to a person',
  awaiting_approval: 'waiting for your decision', waiting_external: 'waiting for someone outside the business',
}

export function estimate(counts: { updates: number; resolved: number; crewDone: number }, rate = hourlyUsd()): MorningData['estimate'] {
  const m = MORNING_MINUTES
  const minutes = counts.updates * m.update + counts.resolved * m.resolvedCase + counts.crewDone * m.crewJobDone
  const usd = Math.round((minutes / 60) * rate * 100) / 100
  return {
    minutes,
    minutesFormula: `${counts.updates} finished update(s) × ${m.update} min + ${counts.resolved} verified case resolution(s) × ${m.resolvedCase} min + ${counts.crewDone} crew job(s) closed × ${m.crewJobDone} min = ${minutes} min`,
    usd,
    usdFormula: `${minutes} min ÷ 60 × $${rate}/hour (what an hour of your team's time is worth) = $${usd}`,
  }
}

export async function morningFacts(db: Db, orgId: string, now = new Date()): Promise<MorningData & { since: string; sinceIso: string }> {
  const last = await db.one<{ created_at: string }>(`select created_at::text from morning_reports where org_id = $1 and report_date < $2 order by report_date desc limit 1`, [orgId, dayOf(now)])
  const since = last ? new Date(last.created_at) : new Date(now.getTime() - 24 * 3600e3)
  const s = since.toISOString(), n = now.toISOString()
  const org = await db.one<{ name: string }>('select name from agencies where id = $1', [orgId])
  const updates = await db.query<{ agent_name: string; headline: string; severity: string; details_path: string | null; at: string }>(
    `select min(agent_name) as agent_name, min(headline) as headline, min(severity) as severity, min(content->>'detailsPath') as details_path, min(created_at)::text as at
     from owner_updates where org_id = $1 and created_at >= $2 and created_at < $3 and status <> 'skipped' group by dedupe_key order by min(created_at) limit 25`, [orgId, s, n])
  const resolved = await db.query<{ ref: string; title: string }>(
    `select ref, title from cases where org_id = $1 and status = 'resolved' and closed_at >= $2 and closed_at < $3 order by closed_at limit 20`, [orgId, s, n])
  const crew = await db.one<{ done: number; open: number }>(
    `select count(*) filter (where status = 'done' and done_at >= $2 and done_at < $3)::int as done,
            count(*) filter (where status not in ('done','cancelled') and job_date = $4::date)::int as open from crew_jobs where org_id = $1`, [orgId, s, n, dayOf(now)])
  const unfinished = await db.query<{ ref: string; title: string; status: string; why: string | null }>(
    `select ref, title, status, coalesce(nullif(status_reason, ''), nullif(next_action, '')) as why from cases
     where org_id = $1 and status in ('blocked','failed','escalated','awaiting_approval','waiting_external') order by updated_at desc limit 10`, [orgId])
  let waiting: MorningData['waiting'] = []
  try { waiting = (await weeklyFacts(db, orgId, weekStartOf(now))).attention.map(a => ({ count: a.count, label: a.label })) } catch (e) { log.warn('notify.morning.attention_failed', { org: orgId, error: (e as Error).message.slice(0, 120) }) }
  const finished = updates.filter(u => u.severity === 'info').length
  return {
    orgName: org?.name ?? 'your business',
    dateLabel: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    since: when(s), sinceIso: s,
    did: updates.map(u => ({ agentName: u.agent_name, headline: u.headline, severity: u.severity, detailsPath: safePath(u.details_path), at: when(u.at) })),
    resolved,
    crew: { done: crew?.done ?? 0, open: crew?.open ?? 0 },
    estimate: estimate({ updates: finished, resolved: resolved.length, crewDone: crew?.done ?? 0 }),
    unfinished: unfinished.map(c => ({ ref: c.ref, title: c.title, status: c.status, why: c.why ?? UNFINISHED_WHY[c.status] ?? 'not finished yet' })),
    waiting,
  }
}

export type MorningResult = { status: 'duplicate' | 'sent' | 'held' | 'failed' | 'skipped'; reportId: string | null; reason?: string }

/** Prepare and send (or hold) one organization's report for the day. Idempotent per organization and day. */
export async function sendMorningReport(orgId: string, opts: { now?: Date } = {}): Promise<MorningResult> {
  const now = opts.now ?? new Date()
  const date = dayOf(now)
  const claim = await admin(async db => {
    const facts = await morningFacts(db, orgId, now)
    const row = await db.one<{ id: string }>(`insert into morning_reports (org_id, report_date, period_start, facts) values ($1,$2,$3,$4) on conflict (org_id, report_date) do nothing returning id`,
      [orgId, date, facts.sinceIso, JSON.stringify(facts)])
    if (!row) return null
    const people = (await updateRecipients(db, orgId)).filter(p => p.prefs.email)
    return { id: row.id, facts, people }
  })
  if (!claim) return { status: 'duplicate', reportId: null, reason: 'already prepared for this day' }
  const finish = async (status: MorningResult['status'], reason: string | null, sent = 0) => {
    await admin(db => db.query('update morning_reports set status = $2, status_reason = $3, sent_to_count = $4 where id = $1', [claim.id, status, reason?.slice(0, 500) ?? null, sent]))
    return { status, reportId: claim.id, ...(reason ? { reason } : {}) }
  }
  if (!claim.people.length) return finish('skipped', 'no owner or admin receives email')
  const outcomes: string[] = []
  let reason: string | null = null
  for (const p of claim.people) {
    try {
      const r = await sendSystemEmail({ key: `morning:${orgId}:${date}:${p.profileId}`, template: 'morning_report', to: p.email, orgId, params: { data: JSON.stringify(claim.facts), appUrl: env.appUrl }, related: { morning_report: claim.id } })
      outcomes.push(r.status)
      if (r.status !== 'sent') reason ??= r.reason
    } catch (e) { outcomes.push('failed'); reason ??= (e as Error).message }
  }
  const sent = outcomes.filter(o => o === 'sent').length
  return finish(sent ? 'sent' : outcomes.includes('held') ? 'held' : 'failed', sent === outcomes.length ? null : reason, sent)
}

registerJobHandler('notify.morning', async (payload, ctx) => {
  const orgId = ctx.job.org_id ?? (typeof payload.orgId === 'string' ? payload.orgId : null)
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return { skipped: true, reason: 'no organization' }
  const r = await sendMorningReport(orgId)
  return { status: r.status, reportId: r.reportId, reason: r.reason ?? null }
}, { maxAttempts: 3, agentWork: false, leaseMs: 3 * 60_000 })

/** Queue today's report for every active business organization (once per organization per UTC day). */
export async function enqueueMorningReports(now = new Date()): Promise<EnqueueResult[]> {
  const orgs = await admin(db => db.query<{ id: string }>(`select id from agencies where org_type = 'merchant' and deleted_at is null order by id`))
  const out: EnqueueResult[] = []
  for (const o of orgs) out.push(await enqueue({ kind: 'notify.morning', orgId: o.id, payload: { orgId: o.id }, idempotencyKey: `morning@${dayOf(now)}` }))
  return out
}
