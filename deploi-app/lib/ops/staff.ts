/**
 * Staff operations console (app/staff/ops): reads across organizations and the few actions Deploi staff may
 * take. Every action is audited in engine_audit with the staff member as actor, and written to ops_logs.
 *
 * What staff may do:
 *   - requeue or cancel a dead (or failed) job;
 *   - stop all agents of an organization on the customer's behalf (exactly the customer's own stop), and turn
 *     that stop off again. Turning it off restarts nothing: every agent stays paused until the customer
 *     resumes it, so staff can stop, never grant;
 *   - acknowledge an alert.
 * What staff can never do: approve, reject, grant, resume or edit anything of a customer. There is no such
 * function here, and the approval paths refuse a staff actor (lib/engine/actor.ts#assertMerchant,
 * lib/approvals/registry.ts, lib/office/approvals.ts).
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import { orgControl } from '../engine/kill-switch'
import { stopOrgAgentsInTx } from '../agents/lifecycle'
import { queueStats, type JobRow } from '../jobs/queue'
import { cleanDetail, maskText, queryOpsLogs, writeOpsLog } from './logs'
import { listAlerts, type AlertRow } from './alerts'

type Staff = Extract<Actor, { kind: 'staff' }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertStaff(actor: Actor | null | undefined): asserts actor is Staff {
  if (!actor || actor.kind !== 'staff') throw new EngineError('forbidden', 'Deploi staff only')
}

// ---------------------------------------------------------------- global state

/** The incident switches, read from the environment (changed in Vercel, never from the app). */
export function globalSwitches(e: Record<string, string | undefined> = process.env) {
  const jobsPaused = (e.JOBS_PAUSED ?? '').trim() === 'on'
  const liveWrites = (e.LIVE_WRITES ?? '').trim() === 'off' ? 'off' : 'on'
  return {
    jobsPaused, liveWrites,
    instructions: {
      jobsPaused: jobsPaused
        ? 'JOBS_PAUSED=on: no worker claims any job. To resume: Vercel → Project → Settings → Environment Variables → set JOBS_PAUSED to off (or delete it) for Production → Redeploy. Queued jobs then run in order; nothing was lost.'
        : 'Jobs run normally. To stop every worker during an incident: Vercel → Project → Settings → Environment Variables → JOBS_PAUSED=on for Production → Redeploy. Queued work waits; leases expire and are picked up after you turn it back off.',
      liveWrites: liveWrites === 'off'
        ? 'LIVE_WRITES=off: no store write is made for any organization (approved changes wait). To resume: set LIVE_WRITES to on (or delete it) in Vercel for Production → Redeploy.'
        : 'Store writes are allowed (each still needs its agent\'s authorization). To block every store write: Vercel → Environment Variables → LIVE_WRITES=off for Production → Redeploy.',
    },
  }
}

// ---------------------------------------------------------------- queue

export type DeadJob = Pick<JobRow, 'id' | 'kind' | 'org_id' | 'agent_id' | 'status' | 'attempts' | 'max_attempts' | 'last_error' | 'created_at' | 'finished_at'> & { org_name: string | null }

export async function queueOverview(db: Db, now = new Date()) {
  const stats = await queueStats(db, now)
  const byKind = await db.query<{ kind: string; queued: number; running: number; dead: number; failed_24h: number }>(
    `select kind, count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'running')::int as running,
            count(*) filter (where status = 'dead')::int as dead, count(*) filter (where status = 'failed' and finished_at > $1)::int as failed_24h
     from jobs where status in ('queued','running','dead') or (status = 'failed' and finished_at > $1) group by kind order by kind`, [new Date(now.getTime() - 864e5).toISOString()])
  const dead = await db.query<DeadJob>(`select j.id, j.kind, j.org_id, j.agent_id, j.status, j.attempts, j.max_attempts, j.last_error, j.created_at, j.finished_at, g.name as org_name
     from jobs j left join agencies g on g.id = j.org_id where j.status in ('dead','failed') order by coalesce(j.finished_at, j.updated_at) desc limit 100`)
  return { stats, byKind, dead: dead.map(d => ({ ...d, last_error: d.last_error ? maskText(d.last_error) : null })) }
}

/** Put a dead or failed job back on the queue with a fresh set of attempts. The handler re-checks authorization when it runs. */
export async function requeueJob(actor: Actor, jobId: string, reason = ''): Promise<{ status: 'queued' }> {
  assertStaff(actor)
  if (!UUID.test(jobId)) throw new EngineError('invalid_input', 'job id')
  return admin(async db => {
    const j = await db.one<JobRow>(`select * from jobs where id = $1 for update`, [jobId])
    if (!j) throw new EngineError('not_found', 'job not found')
    if (j.status !== 'dead' && j.status !== 'failed') throw new EngineError('not_pending', `only a dead or failed job can be requeued (this one is ${j.status})`)
    await db.query(`update jobs set status = 'queued', attempts = 0, run_after = now(), lease_until = null, lease_owner = null, finished_at = null, cancel_reason = null where id = $1`, [jobId])
    await audit(db, { orgId: j.org_id, entityType: 'job', entityId: j.id, event: 'job.requeued_by_staff', actor: actor.label, detail: { kind: j.kind, previous_status: j.status, previous_attempts: j.attempts, last_error: j.last_error?.slice(0, 200) ?? null, reason: reason.slice(0, 300) } })
    await writeOpsLog({ level: 'warn', event: 'staff.job_requeued', orgId: j.org_id, jobId: j.id, summary: `${actor.label} requeued ${j.kind}`, detail: { kind: j.kind } }, db)
    return { status: 'queued' as const }
  })
}

export async function cancelJob(actor: Actor, jobId: string, reason = ''): Promise<{ status: 'cancelled' }> {
  assertStaff(actor)
  if (!UUID.test(jobId)) throw new EngineError('invalid_input', 'job id')
  return admin(async db => {
    const j = await db.one<JobRow>(`select * from jobs where id = $1 for update`, [jobId])
    if (!j) throw new EngineError('not_found', 'job not found')
    if (!['dead', 'failed', 'queued'].includes(j.status)) throw new EngineError('not_pending', `a ${j.status} job cannot be cancelled here`)
    const why = (reason.trim() || 'cancelled by Deploi staff').slice(0, 300)
    await db.query(`update jobs set status = 'cancelled', cancel_reason = $2, finished_at = now(), lease_until = null where id = $1`, [jobId, `${why} (${actor.label})`.slice(0, 300)])
    await audit(db, { orgId: j.org_id, entityType: 'job', entityId: j.id, event: 'job.cancelled_by_staff', actor: actor.label, detail: { kind: j.kind, previous_status: j.status, reason: why } })
    await writeOpsLog({ level: 'warn', event: 'staff.job_cancelled', orgId: j.org_id, jobId: j.id, summary: `${actor.label} cancelled ${j.kind}`, detail: { kind: j.kind } }, db)
    return { status: 'cancelled' as const }
  })
}

// ---------------------------------------------------------------- organizations

export async function listOrgs(db: Db, q = '') {
  return db.query<{ id: string; name: string; open_cases: number; attention: number; live_alerts: number; agents_stopped: boolean }>(
    `select g.id, g.name,
       (select count(*)::int from cases c where c.org_id = g.id and c.status not in ('resolved','cancelled')) as open_cases,
       (select count(*)::int from cases c where c.org_id = g.id and c.status in ('blocked','failed','escalated')) as attention,
       (select count(*)::int from alerts a where a.org_id = g.id and a.status <> 'resolved') as live_alerts,
       coalesce((select agents_stopped from org_controls o where o.org_id = g.id), false) as agents_stopped
     from agencies g where g.deleted_at is null and ($1 = '' or g.name ilike '%' || $1 || '%' or g.id::text = $1) order by g.name limit 100`, [q.trim().slice(0, 100)])
}

export async function orgOverview(db: Db, orgId: string, now = new Date()) {
  if (!UUID.test(orgId)) throw new EngineError('invalid_input', 'organization id')
  const org = await db.one<{ id: string; name: string; plan_key: string | null; deleted_at: string | null }>('select id, name, plan_key, deleted_at from agencies where id = $1', [orgId])
  if (!org) throw new EngineError('not_found', 'organization not found')
  const since = new Date(now.getTime() - 7 * 864e5).toISOString()
  const [agents, office, library, cases, failures, failedJobs, control, alerts] = await Promise.all([
    db.query<{ id: string; name: string; status: string; next_run_at: string | null }>(`select id, name, status, next_run_at from agents where org_id = $1 and status <> 'deleted' order by name`, [orgId]),
    db.query<{ id: string; name: string; kind: string; status: string }>(`select id, name, kind, status from office_agents where org_id = $1 and status <> 'deleted' order by name`, [orgId]),
    db.query<{ agent_key: string; enabled: boolean }>(`select agent_key, enabled from library_switches where org_id = $1 order by agent_key`, [orgId]),
    db.query<{ status: string; n: number }>(`select status, count(*)::int as n from cases where org_id = $1 group by status order by status`, [orgId]),
    db.query<{ ref: string; kind: string; status: string; status_reason: string | null; updated_at: string }>(
      `select ref, kind, status, status_reason, updated_at from cases where org_id = $1 and status in ('failed','escalated','blocked') and updated_at > $2 order by updated_at desc limit 25`, [orgId, since]),
    db.query<{ id: string; kind: string; status: string; last_error: string | null; finished_at: string | null }>(
      `select id, kind, status, last_error, finished_at from jobs where org_id = $1 and status in ('failed','dead') and coalesce(finished_at, updated_at) > $2 order by coalesce(finished_at, updated_at) desc limit 25`, [orgId, since]),
    orgControl(db, orgId),
    listAlerts(db, { orgId, status: 'all', limit: 25 }),
  ])
  return {
    org, agents, officeAgents: office, library, casesByStatus: Object.fromEntries(cases.map(c => [c.status, c.n])),
    recentFailures: failures.map(f => ({ ...f, status_reason: f.status_reason ? maskText(f.status_reason) : null })),
    failedJobs: failedJobs.map(j => ({ ...j, last_error: j.last_error ? maskText(j.last_error) : null })),
    control: control ?? { org_id: orgId, agents_stopped: false, stop_reason: null, stopped_by: null, stopped_at: null, resumed_by: null, resumed_at: null },
    alerts,
  }
}

/** Stop every agent of an organization on the customer's behalf: exactly what the customer's own stop does. */
export async function staffStopOrg(actor: Actor, orgId: string, reason: string) {
  assertStaff(actor)
  if (!UUID.test(orgId)) throw new EngineError('invalid_input', 'organization id')
  const why = reason.trim().slice(0, 240)
  if (!why) throw new EngineError('invalid_input', 'say why the organization is being stopped (the customer sees it)')
  return admin(async db => {
    const org = await db.one<{ id: string }>('select id from agencies where id = $1 and deleted_at is null', [orgId])
    if (!org) throw new EngineError('not_found', 'organization not found')
    const r = await stopOrgAgentsInTx(db, orgId, actor.label, `stopped by Deploi support: ${why}`)
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'org.agents_stopped_by_staff', actor: actor.label, detail: { reason: why, on_behalf_of: 'customer', ...r } })
    await writeOpsLog({ level: 'warn', event: 'staff.org_stopped', orgId, summary: `${actor.label} stopped all agents`, detail: { agents_paused: r.agentsPaused } }, db)
    return r
  })
}

/** Turn a stop off. Nothing restarts: each agent stays paused until the customer resumes it (staff never grant). */
export async function staffClearOrgStop(actor: Actor, orgId: string, reason = '') {
  assertStaff(actor)
  if (!UUID.test(orgId)) throw new EngineError('invalid_input', 'organization id')
  return admin(async db => {
    const r = await db.query(`update org_controls set agents_stopped = false, resumed_by = $2, resumed_at = now() where org_id = $1 and agents_stopped returning org_id`, [orgId, actor.label])
    if (!r.length) throw new EngineError('not_pending', 'agents are not stopped')
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'org.agents_stop_cleared_by_staff', actor: actor.label, detail: { reason: reason.slice(0, 300), agents_resumed: 0, note: 'agents stay paused until the customer resumes them' } })
    await writeOpsLog({ level: 'warn', event: 'staff.org_stop_cleared', orgId, summary: `${actor.label} turned the organization stop off (agents stay paused)` }, db)
    return { cleared: true, agentsResumed: 0 }
  })
}

// ---------------------------------------------------------------- cases and alerts

/** Find a case by its reference (DC-...), with its history; personal details in the text are masked. */
export async function findCaseByRef(db: Db, ref: string) {
  const r = ref.trim().toUpperCase()
  if (!/^DC-[A-Z0-9-]{3,30}$/.test(r)) return null
  const c = await db.one<{ id: string; org_id: string; ref: string; suite: string; kind: string; status: string; status_reason: string | null; title: string; agent_kind: string | null; agent_ref: string | null; opened_at: string; closed_at: string | null; next_check_at: string | null; deadline_at: string | null; attempts: number }>(
    `select id, org_id, ref, suite, kind, status, status_reason, title, agent_kind, agent_ref, opened_at, closed_at, next_check_at, deadline_at, attempts from cases where ref = $1`, [r])
  if (!c) return null
  const org = await db.one<{ name: string }>('select name from agencies where id = $1', [c.org_id])
  const logs = await queryOpsLogs(db, { caseRef: c.ref, limit: 200 })
  return { case: { ...c, title: maskText(c.title), status_reason: c.status_reason ? maskText(c.status_reason) : null }, orgName: org?.name ?? null, logs }
}

export async function acknowledgeAlert(actor: Actor, alertId: string): Promise<AlertRow> {
  assertStaff(actor)
  if (!UUID.test(alertId)) throw new EngineError('invalid_input', 'alert id')
  return admin(async db => {
    const a = await db.one<AlertRow>(`update alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now() where id = $1 and status = 'open' returning *`, [alertId, actor.label])
    if (!a) throw new EngineError('not_pending', 'only an open alert can be acknowledged')
    await audit(db, { orgId: a.org_id, entityType: 'org', entityId: a.org_id ?? a.id, event: 'alert.acknowledged', actor: actor.label, detail: { alert_id: a.id, rule: a.rule, subject: a.subject } })
    await writeOpsLog({ event: 'staff.alert_acknowledged', orgId: a.org_id, correlationId: a.id, summary: `${actor.label} acknowledged: ${a.title}`, detail: { rule: a.rule } }, db)
    return a
  })
}

export { cleanDetail }
