/**
 * Durable job queue in Postgres (table `jobs`).
 *
 *  - enqueue(): one job per (organization, kind, idempotency key), whatever its status; a repeated
 *    enqueue returns the first job. Refused while the organization has stopped all agents (agent work).
 *  - claim: `for update skip locked`, so two workers never hold the same job; at most
 *    `orgConcurrency` jobs of one organization run at once (checked under a per-organization
 *    advisory lock, so two workers cannot both take the last slot).
 *  - lease: a claimed job carries lease_until + lease_owner and is extended while its handler runs.
 *    A worker that crashes stops extending it; once the lease expires the job can be claimed again.
 *    Handlers must therefore be safe to run twice: every consequential step they call is protected by
 *    the engine's own idempotency (one execution per approval, one send per message row) and its
 *    reconciliation of interrupted work.
 *  - failure: retried with exponential backoff; after max_attempts the job is dead (dead-letter) and
 *    audited. PermanentJobError fails it at once.
 *  - cancellation: cancelJobs() by organization or agent (pause, revoke, delete, stop all agents).
 *  - JOBS_PAUSED=on: no job is claimed anywhere (incident switch).
 * Completion is accepted only from the worker that still holds the lease.
 */
import { randomUUID } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { log } from '../log'
import { orgStopReason } from '../engine/kill-switch'
import { flushWorkflowCounters, recordWorkflow } from '../ai/meter'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'
export type JobRow = {
  id: string; kind: string; org_id: string | null; agent_id: string | null; payload: Record<string, unknown>; idempotency_key: string | null
  status: JobStatus; attempts: number; max_attempts: number; run_after: string; lease_until: string | null; lease_owner: string | null
  last_error: string | null; result: Record<string, unknown> | null; cancel_reason: string | null
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null
}
export type JobContext = { job: JobRow; workerId: string; /** epoch ms by which the handler should return */ deadline: number }
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<Record<string, unknown> | void>
type HandlerEntry = { fn: JobHandler; leaseMs: number; maxAttempts: number; agentWork: boolean }

/** A failure that retrying cannot fix: the job fails at once (no backoff, no dead-letter wait). */
export class PermanentJobError extends Error { constructor(message: string) { super(message); this.name = 'PermanentJobError' } }

const e = (k: string) => (process.env[k] ?? '').trim()
const num = (k: string, d: number) => { const v = Number(e(k)); return Number.isFinite(v) && v > 0 ? v : d }
export const jobsConfig = {
  get paused() { return e('JOBS_PAUSED') === 'on' },
  get orgConcurrency() { return num('JOBS_ORG_CONCURRENCY', 2) },
  get backoffBaseMs() { return num('JOBS_BACKOFF_BASE_MS', 30_000) },
  get backoffMaxMs() { return num('JOBS_BACKOFF_MAX_MS', 3600_000) },
  defaultLeaseMs: 5 * 60_000,
  defaultMaxAttempts: 5,
}

const handlers = new Map<string, HandlerEntry>()
const KIND = /^[a-z][a-z0-9_.:-]{1,63}$/

/**
 * Register the function that runs jobs of `kind`. `agentWork`: the job acts for an agent, so it is
 * refused and cancelled while its organization has stopped all agents.
 */
export function registerJobHandler(kind: string, fn: JobHandler, opts: { leaseMs?: number; maxAttempts?: number; agentWork?: boolean } = {}) {
  if (!KIND.test(kind)) throw new Error(`invalid job kind: ${kind}`)
  handlers.set(kind, { fn, leaseMs: opts.leaseMs ?? jobsConfig.defaultLeaseMs, maxAttempts: opts.maxAttempts ?? jobsConfig.defaultMaxAttempts, agentWork: opts.agentWork ?? true })
}
export const registeredJobKinds = () => [...handlers.keys()]

/** Delay before attempt n+1 after n failed attempts: base * 2^(n-1), capped. */
export function backoffMs(attempts: number, base = jobsConfig.backoffBaseMs, max = jobsConfig.backoffMaxMs): number {
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1))
}

export type EnqueueInput = { kind: string; orgId?: string | null; agentId?: string | null; payload?: Record<string, unknown>; idempotencyKey?: string | null; runAfter?: Date; maxAttempts?: number }
export type EnqueueResult = { id: string; created: boolean; status: JobStatus } | { id: null; created: false; status: 'refused'; reason: string }

const NIL = '00000000-0000-0000-0000-000000000000'

async function enqueueIn(db: Db, i: EnqueueInput): Promise<EnqueueResult> {
  if (!KIND.test(i.kind)) throw new Error(`invalid job kind: ${i.kind}`)
  const h = handlers.get(i.kind)
  if (i.orgId && (h?.agentWork ?? true)) {
    const stopped = await orgStopReason(db, i.orgId)
    if (stopped) return { id: null, created: false, status: 'refused', reason: stopped }
  }
  const row = await db.one<{ id: string; status: JobStatus }>(
    `insert into jobs (kind, org_id, agent_id, payload, idempotency_key, run_after, max_attempts) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7)
     on conflict (coalesce(org_id, '${NIL}'::uuid), kind, idempotency_key) where idempotency_key is not null do nothing returning id, status`,
    [i.kind, i.orgId ?? null, i.agentId ?? null, JSON.stringify(i.payload ?? {}), i.idempotencyKey ?? null, i.runAfter?.toISOString() ?? null, i.maxAttempts ?? h?.maxAttempts ?? jobsConfig.defaultMaxAttempts])
  if (row) return { id: row.id, created: true, status: row.status }
  const existing = await db.one<{ id: string; status: JobStatus }>(
    `select id, status from jobs where coalesce(org_id, '${NIL}'::uuid) = coalesce($1::uuid, '${NIL}'::uuid) and kind = $2 and idempotency_key = $3`, [i.orgId ?? null, i.kind, i.idempotencyKey])
  return { id: existing!.id, created: false, status: existing!.status }
}

/** Add a job (inside the caller's transaction when `db` is given, so it commits with the work that caused it). */
export function enqueue(i: EnqueueInput, db?: Db): Promise<EnqueueResult> {
  return db ? enqueueIn(db, i) : admin(d => enqueueIn(d, i))
}

/** Cancel queued jobs of an organization or an agent. Running jobs finish their current step; their handlers re-check authorization. */
export async function cancelJobs(db: Db, f: { orgId?: string | null; agentId?: string | null; reason: string; actor: string; agentWorkOnly?: boolean }): Promise<number> {
  if (!f.orgId && !f.agentId) throw new Error('cancelJobs needs an organization or an agent')
  const kinds = f.agentWorkOnly ? [...handlers.entries()].filter(([, h]) => !h.agentWork).map(([k]) => k) : []
  const r = await db.query<{ id: string; org_id: string | null }>(
    `update jobs set status = 'cancelled', cancel_reason = $3, finished_at = now(), lease_until = null
     where status = 'queued' and ($1::uuid is null or org_id = $1) and ($2::uuid is null or agent_id = $2) and not (kind = any($4::text[])) returning id, org_id`,
    [f.orgId ?? null, f.agentId ?? null, f.reason.slice(0, 300), kinds])
  if (r.length) await audit(db, { orgId: f.orgId ?? r[0].org_id, entityType: 'job', entityId: f.agentId ?? f.orgId ?? null, event: 'jobs.cancelled', actor: f.actor, detail: { count: r.length, agent_id: f.agentId ?? null, reason: f.reason } })
  return r.length
}

/** Claim the next due job (or one whose lease expired). Null when nothing is due or every due organization is at its limit. */
export async function claimNext(workerId: string, opts: { now?: Date; kinds?: string[] } = {}): Promise<JobRow | null> {
  const now = opts.now ?? new Date()
  const skipOrgs = new Set<string>()
  for (let tries = 0; tries < 25; tries++) {
    const out = await admin(async db => {
      const c = await db.one<JobRow>(
        `select * from jobs where ((status = 'queued' and run_after <= $1) or (status = 'running' and lease_until < $1))
           and not (coalesce(org_id, '${NIL}'::uuid) = any($2::uuid[])) and ($3::text[] is null or kind = any($3::text[]))
         order by run_after, created_at limit 1 for update skip locked`, [now.toISOString(), [...skipOrgs], opts.kinds ?? null])
      if (!c) return { kind: 'none' as const }
      const h = handlers.get(c.kind)
      if (c.org_id) {
        // serialize claims per organization so the concurrency limit holds across workers
        await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 7311))`, [`jobs-org:${c.org_id}`])
        if (h?.agentWork ?? true) {
          const stopped = await orgStopReason(db, c.org_id)
          if (stopped) {
            await db.query(`update jobs set status = 'cancelled', cancel_reason = $2, finished_at = now(), lease_until = null where id = $1`, [c.id, stopped])
            return { kind: 'retry' as const }
          }
        }
        const running = await db.one<{ n: string }>(`select count(*)::text as n from jobs where org_id = $1 and status = 'running' and lease_until >= $2 and id <> $3`, [c.org_id, now.toISOString(), c.id])
        if (Number(running?.n ?? 0) >= jobsConfig.orgConcurrency) return { kind: 'skip_org' as const, orgId: c.org_id }
      }
      if (c.status === 'running' && c.attempts >= c.max_attempts) {
        // the last attempt's worker stopped without finishing: dead-letter, never a silent extra attempt
        await db.query(`update jobs set status = 'dead', last_error = $2, finished_at = now(), lease_until = null where id = $1`, [c.id, `the worker stopped during attempt ${c.attempts} of ${c.max_attempts} (lease expired)`])
        await audit(db, { orgId: c.org_id, entityType: 'job', entityId: c.id, event: 'job.dead', actor: `worker:${workerId}`, detail: { kind: c.kind, attempts: c.attempts, reason: 'lease expired' } })
        return { kind: 'retry' as const }
      }
      const leaseMs = h?.leaseMs ?? jobsConfig.defaultLeaseMs
      const claimed = await db.one<JobRow>(
        `update jobs set status = 'running', attempts = attempts + 1, lease_owner = $2, lease_until = $3, started_at = coalesce(started_at, $4), last_error = case when status = 'running' then 'lease expired: the previous worker stopped' else last_error end
         where id = $1 returning *`, [c.id, workerId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()])
      return { kind: 'claimed' as const, job: claimed! }
    })
    if (out.kind === 'none') return null
    if (out.kind === 'claimed') return out.job
    if (out.kind === 'skip_org') skipOrgs.add(out.orgId)
  }
  return null
}

/** Extend the lease while the handler runs; false when this worker no longer holds the job. */
export async function extendLease(jobId: string, workerId: string, ms: number): Promise<boolean> {
  const r = await admin(db => db.query(`update jobs set lease_until = now() + ($3 || ' milliseconds')::interval where id = $1 and lease_owner = $2 and status = 'running' returning id`, [jobId, workerId, String(ms)]))
  return r.length > 0
}

export type JobOutcome = { jobId: string; kind: string; status: JobStatus | 'lost_lease'; attempts: number; error?: string; result?: Record<string, unknown> | null }

async function settle(job: JobRow, workerId: string, outcome: { ok: true; result: Record<string, unknown> | null } | { ok: false; error: string; permanent: boolean }, now: () => Date): Promise<JobOutcome> {
  // workflow cost: one job run for the organization (lib/ai/meter.ts), plus provider calls counted during the run
  if (job.org_id) await admin(db => recordWorkflow(db, job.org_id!, 'job_run', '', 1, now())).catch(() => {})
  await flushWorkflowCounters(now())
  return admin(async db => {
    if (outcome.ok) {
      const r = await db.query(`update jobs set status = 'succeeded', result = $3, finished_at = now(), lease_until = null, last_error = null where id = $1 and lease_owner = $2 and status = 'running' returning id`,
        [job.id, workerId, outcome.result ? JSON.stringify(outcome.result) : null])
      return { jobId: job.id, kind: job.kind, status: r.length ? 'succeeded' : 'lost_lease', attempts: job.attempts, result: outcome.result }
    }
    const err = outcome.error.slice(0, 500)
    const dead = !outcome.permanent && job.attempts >= job.max_attempts
    const status: JobStatus = outcome.permanent ? 'failed' : dead ? 'dead' : 'queued'
    const runAfter = status === 'queued' ? new Date(now().getTime() + backoffMs(job.attempts)).toISOString() : null
    const r = await db.query(
      `update jobs set status = $3, last_error = $4, run_after = coalesce($5::timestamptz, run_after), lease_until = null, lease_owner = case when $3 = 'queued' then null else lease_owner end,
         finished_at = case when $3 = 'queued' then null else now() end where id = $1 and lease_owner = $2 and status = 'running' returning id`,
      [job.id, workerId, status, err, runAfter])
    if (!r.length) return { jobId: job.id, kind: job.kind, status: 'lost_lease', attempts: job.attempts, error: err }
    if (status !== 'queued') await audit(db, { orgId: job.org_id, entityType: 'job', entityId: job.id, event: `job.${status}`, actor: `worker:${workerId}`, detail: { kind: job.kind, attempts: job.attempts, reason: err, agent_id: job.agent_id } })
    return { jobId: job.id, kind: job.kind, status, attempts: job.attempts, error: err }
  })
}

/** Run one claimed job with its handler, keeping the lease alive while it runs. */
export async function runClaimed(job: JobRow, workerId: string, opts: { deadline?: number; now?: () => Date } = {}): Promise<JobOutcome> {
  const now = opts.now ?? (() => new Date())
  const h = handlers.get(job.kind)
  if (!h) return settle(job, workerId, { ok: false, error: `no handler is registered for ${job.kind}`, permanent: false }, now)
  const beat = setInterval(() => { extendLease(job.id, workerId, h.leaseMs).catch(() => {}) }, Math.max(1000, Math.floor(h.leaseMs / 3)))
  try {
    const result = await h.fn(job.payload ?? {}, { job, workerId, deadline: opts.deadline ?? Date.now() + h.leaseMs })
    return await settle(job, workerId, { ok: true, result: result ?? null }, now)
  } catch (err) {
    log.warn('jobs.attempt_failed', { job_id: job.id, kind: job.kind, attempts: job.attempts, error: (err as Error).message.slice(0, 200) })
    return await settle(job, workerId, { ok: false, error: (err as Error).message || 'failed', permanent: err instanceof PermanentJobError }, now)
  } finally {
    clearInterval(beat)
  }
}

/** Claim and run due jobs one after another until `limit` jobs ran, nothing is due, or `deadlineMs` passed. */
export async function runDueJobs(opts: { limit?: number; deadlineMs?: number; workerId?: string; now?: () => Date; kinds?: string[] } = {}): Promise<{ paused: boolean; ran: JobOutcome[] }> {
  if (jobsConfig.paused) return { paused: true, ran: [] }
  const workerId = opts.workerId ?? `w-${randomUUID().slice(0, 8)}`
  const started = Date.now()
  const deadline = started + (opts.deadlineMs ?? 240_000)
  const limit = opts.limit ?? 50
  const ran: JobOutcome[] = []
  while (ran.length < limit && Date.now() < deadline) {
    const job = await claimNext(workerId, { now: opts.now?.(), kinds: opts.kinds })
    if (!job) break
    ran.push(await runClaimed(job, workerId, { deadline, now: opts.now }))
  }
  return { paused: false, ran }
}

/** Queue health without tenant data: counts and ages only. */
export async function queueStats(db: Db, now = new Date()) {
  const r = await db.one<{ queued: string; due: string; running: string; dead: string; oldest: string | null; expired: string }>(
    `select count(*) filter (where status = 'queued')::text as queued,
            count(*) filter (where status = 'queued' and run_after <= $1)::text as due,
            count(*) filter (where status = 'running')::text as running,
            count(*) filter (where status = 'dead')::text as dead,
            count(*) filter (where status = 'running' and lease_until < $1)::text as expired,
            min(run_after) filter (where status = 'queued' and run_after <= $1) as oldest
     from jobs`, [now.toISOString()])
  return {
    queued: Number(r?.queued ?? 0), due: Number(r?.due ?? 0), running: Number(r?.running ?? 0), dead: Number(r?.dead ?? 0), expiredLeases: Number(r?.expired ?? 0),
    oldestDueAgeSec: r?.oldest ? Math.max(0, Math.round((now.getTime() - new Date(r.oldest).getTime()) / 1000)) : 0,
  }
}
