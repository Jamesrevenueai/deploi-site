/**
 * Weekly summary email to the merchant: what each agent did, what needs their attention, and an
 * estimated time saved, labelled as an estimate with its formula. One summary per organization per
 * week (unique row, claimed under a lock). Sent from Deploi's own address only when EMAIL_LIVE_SENDS
 * allows it for every recipient; otherwise it is kept as "prepared" with the reason, never "sent".
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { withActor, type Actor } from '../engine/actor'
import { env, COMPANY_EMAIL, COMPANY_NAME } from '../env'
import { resendSystemEmail } from '../email/adapters/deploi'
import { emailConfig, liveSendAllowed } from '../email/config'

/** Minutes of merchant work one finished item replaces. Assumptions, shown with every estimate. */
export const ESTIMATE_MINUTES = { verifiedChange: 3, draftedChange: 1, emailSent: 5, emailDrafted: 3, taskDone: 2 } as const

export type AgentWeek = {
  agentId: string; name: string; status: string
  runs: number; verified: number; drafted: number; failed: number
  emailsAccepted: number; emailsDrafted: number; tasksDone: number
}
export type Attention = { kind: string; count: number; label: string }
export type WeeklyFacts = {
  orgName: string; weekStart: string; weekEnd: string
  agents: AgentWeek[]; attention: Attention[]
  estimate: { minutes: number; formula: string; label: 'Estimate' }
}

/** Monday 00:00 UTC of the week containing `d`. */
export function weekStartOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
  return x
}

export function estimateMinutes(agents: AgentWeek[]): WeeklyFacts['estimate'] {
  const t = agents.reduce((a, g) => ({ v: a.v + g.verified, d: a.d + g.drafted, s: a.s + g.emailsAccepted, e: a.e + g.emailsDrafted, k: a.k + g.tasksDone }), { v: 0, d: 0, s: 0, e: 0, k: 0 })
  const m = ESTIMATE_MINUTES
  const minutes = t.v * m.verifiedChange + t.d * m.draftedChange + t.s * m.emailSent + t.e * m.emailDrafted + t.k * m.taskDone
  const formula = `${t.v} verified change(s) × ${m.verifiedChange} min + ${t.d} drafted change(s) × ${m.draftedChange} min + ${t.s} email(s) sent × ${m.emailSent} min + ${t.e} email draft(s) × ${m.emailDrafted} min + ${t.k} task(s) done × ${m.taskDone} min`
  return { minutes, formula, label: 'Estimate' }
}

export async function weeklyFacts(db: Db, orgId: string, weekStart: Date): Promise<WeeklyFacts> {
  const from = weekStart.toISOString(), to = new Date(weekStart.getTime() + 7 * 864e5).toISOString()
  const org = await db.one<{ name: string }>('select name from agencies where id = $1', [orgId])
  const agents = await db.query<AgentWeek>(
    `select a.id as "agentId", a.name, a.status,
       (select count(*)::int from agent_runs r where r.agent_id = a.id and r.started_at >= $2 and r.started_at < $3) as runs,
       (select count(*)::int from executions e where e.agent_id = a.id and e.status = 'verified' and e.finished_at >= $2 and e.finished_at < $3) as verified,
       (select count(*)::int from proposals p where p.agent_id = a.id and p.status_reason like 'draft:%' and p.created_at >= $2 and p.created_at < $3) as drafted,
       (select count(*)::int from executions e where e.agent_id = a.id and e.status in ('failed','verification_failed') and e.finished_at >= $2 and e.finished_at < $3) as failed,
       (select count(*)::int from email_messages m where m.agent_id = a.id and m.status = 'accepted' and m.accepted_at >= $2 and m.accepted_at < $3) as "emailsAccepted",
       (select count(*)::int from email_messages m where m.agent_id = a.id and m.status = 'draft' and m.created_at >= $2 and m.created_at < $3) as "emailsDrafted",
       (select count(*)::int from agent_tasks t where t.agent_id = a.id and t.status = 'done' and t.finished_at >= $2 and t.finished_at < $3) as "tasksDone"
     from agents a where a.org_id = $1 and a.status <> 'deleted' order by a.name`, [orgId, from, to])
  const n = async (sql: string) => Number((await db.one<{ n: string }>(sql, [orgId]))?.n ?? 0)
  const attention: Attention[] = [
    { kind: 'changes', count: await n(`select count(*)::text as n from proposals where org_id = $1 and agent_id is not null and status = 'pending_approval' and expires_at > now() and coalesce(status_reason, '') not like 'draft:%'`), label: 'change(s) waiting for your approval' },
    { kind: 'emails', count: await n(`select count(*)::text as n from email_messages where org_id = $1 and status = 'awaiting_approval'`), label: 'email(s) waiting for your approval' },
    { kind: 'unknown', count: await n(`select count(*)::text as n from email_messages where org_id = $1 and status = 'delivery_unknown'`), label: 'email(s) with unknown delivery to check' },
    { kind: 'person', count: await n(`select count(*)::text as n from issues where org_id = $1 and agent_id is not null and kind = 'needs_person' and status in ('open','needs_review')`), label: 'problem(s) that need a person' },
    { kind: 'tasks', count: await n(`select count(*)::text as n from agent_tasks where org_id = $1 and status = 'needs_approval'`), label: 'task(s) outside an agent\'s rules' },
    { kind: 'quarantine', count: await n(`select count(*)::text as n from email_inbound where org_id = $1 and status = 'quarantined' and received_at > now() - interval '7 days'`), label: 'incoming email(s) quarantined' },
    { kind: 'expiring', count: await n(`select count(*)::text as n from agent_policies p join agents a on a.active_policy_id = p.id where p.org_id = $1 and a.status = 'active'
        and least(nullif(p.policy->>'validUntil', '')::timestamptz, nullif(p.policy->'email'->>'validUntil', '')::timestamptz) < now() + interval '14 days'`), label: 'authorization(s) ending within 14 days' },
  ].filter(a => a.count > 0)
  return { orgName: org?.name ?? 'your store', weekStart: from.slice(0, 10), weekEnd: new Date(weekStart.getTime() + 6 * 864e5).toISOString().slice(0, 10), agents, attention, estimate: estimateMinutes(agents) }
}

export function renderWeekly(f: WeeklyFacts, appUrl: string): { subject: string; text: string } {
  const lines = [
    `Your Deploi agents, week of ${f.weekStart} to ${f.weekEnd}`, '',
    'What each agent did:',
    ...(f.agents.length ? f.agents.map(a => `- ${a.name} (${a.status}): ${a.runs} run(s), ${a.verified} change(s) verified, ${a.drafted} change(s) drafted, ${a.failed} failed, ${a.emailsAccepted} email(s) sent, ${a.emailsDrafted} email draft(s), ${a.tasksDone} task(s) done`) : ['- No agents yet.']),
    '', 'Needs your attention:',
    ...(f.attention.length ? f.attention.map(a => `- ${a.count} ${a.label}`) : ['- Nothing is waiting for you.']),
    '', `Estimated time saved: about ${f.estimate.minutes} minutes. This is an estimate, not a measurement: ${f.estimate.formula}.`,
    '', `Open Deploi: ${appUrl.replace(/\/$/, '')}/store/agents`,
  ]
  return { subject: `Deploi weekly summary: ${f.agents.reduce((s, a) => s + a.verified, 0)} verified, ${f.attention.reduce((s, a) => s + a.count, 0)} waiting for you`, text: lines.join('\n') }
}

/** Prepare (and, when allowed, send) one organization's summary for the week. Idempotent per week. */
export async function sendWeeklySummary(orgId: string, opts: { now?: Date; actor?: string } = {}) {
  const now = opts.now ?? new Date()
  const week = weekStartOf(now)
  const actor = opts.actor ?? 'system:weekly'
  const claim = await admin(async db => {
    const facts = await weeklyFacts(db, orgId, week)
    const recipients = (await db.query<{ email: string }>(`select lower(email) as email from profiles where agency_id = $1 and role = 'client' order by email`, [orgId])).map(r => r.email)
    const row = await db.one<{ id: string }>(`insert into weekly_summaries (org_id, week_start, status, recipients, facts) values ($1,$2,'prepared',$3,$4)
      on conflict (org_id, week_start) do nothing returning id`, [orgId, week.toISOString().slice(0, 10), recipients, JSON.stringify(facts)])
    if (!row) return null // already prepared or sent this week
    return { id: row.id, facts, recipients }
  })
  if (!claim) return { status: 'duplicate' as const }
  const finish = (status: string, reason: string | null, providerId: string | null = null) => admin(async db => {
    await db.query(`update weekly_summaries set status = $2, status_reason = $3, provider_message_id = $4, sent_at = case when $2 = 'accepted' then now() else null end where id = $1`, [claim.id, status, reason, providerId])
    await audit(db, { orgId, entityType: 'subscription', entityId: claim.id, event: `weekly_summary.${status}`, actor, detail: { reason, recipients: claim.recipients.length, week_start: claim.facts.weekStart } })
    return { status, reason }
  })
  if (!claim.recipients.length) return finish('skipped', 'no merchant user to send to')
  if (!emailConfig.resendKey) return finish('prepared', 'not sent: no email provider is configured in this environment')
  const live = liveSendAllowed(claim.recipients)
  if (!live.ok) return finish('prepared', `not sent: ${live.reason}`)
  await admin(db => db.query(`update weekly_summaries set status = 'sending' where id = $1`, [claim.id]))
  const { subject, text } = renderWeekly(claim.facts, env.appUrl)
  const r = await resendSystemEmail({ from: `${COMPANY_NAME} <${COMPANY_EMAIL}>`, to: claim.recipients, subject, text, idempotencyKey: `weekly-${claim.id}` })
  if (r.outcome === 'accepted') return finish('accepted', null, r.providerMessageId)
  if (r.outcome === 'uncertain') return finish('failed', `delivery unknown: ${r.message}; not resent automatically`)
  return finish('failed', r.outcome === 'rejected' ? r.message : 'the provider asked to wait; not sent this week')
}

/** Cron: every merchant organization with at least one agent. */
export async function sendWeeklySummaries(opts: { now?: Date } = {}) {
  const orgs = await admin(db => db.query<{ id: string }>(`select distinct a.org_id as id from agents a join agencies g on g.id = a.org_id where a.status <> 'deleted' and g.org_type = 'merchant'`))
  const out: { orgId: string; status: string }[] = []
  for (const o of orgs) out.push({ orgId: o.id, status: (await sendWeeklySummary(o.id, opts)).status })
  return out
}

/** The merchant's preview of this week's summary (computed live, never sent from here). */
export async function weeklyPreview(actor: Actor, orgId: string, now = new Date()) {
  const facts = await withActor(actor, db => weeklyFacts(db, orgId, weekStartOf(now)))
  const last = await withActor(actor, db => db.one<{ week_start: string; status: string; status_reason: string | null; sent_at: string | null }>(
    'select week_start::text, status, status_reason, sent_at from weekly_summaries where org_id = $1 order by week_start desc limit 1', [orgId]))
  return { facts, rendered: renderWeekly(facts, env.appUrl), last, liveSends: emailConfig.liveSends }
}
