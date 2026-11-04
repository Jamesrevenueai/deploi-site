/**
 * Durable job queue: two workers never run the same job, a crashed worker's job is recovered after its
 * lease, failures back off exponentially and dead-letter after max attempts, idempotency keys dedupe,
 * per-organization concurrency holds, pause/revoke cancel an agent's queued jobs, the organization stop
 * cancels and refuses agent work, and JOBS_PAUSED stops every worker.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { backoffMs, cancelJobs, claimNext, enqueue, registerJobHandler, runClaimed, runDueJobs, PermanentJobError } from '../../lib/jobs'
import { pauseAgent, revokeAgent, resumeAgent, stopAllAgents, clearAgentStop, grantPolicy, createAgent } from '../../lib/agents/lifecycle'
import { merchantActor, resetMerchant } from '../merchant/helpers'
import { NW, HB, grantedAgent, cleanInfra, STOCK } from './helpers'

const ready = await prepareDb()
const ran: string[] = []
let failTimes = 0
registerJobHandler('test.record', async (p, ctx) => { ran.push(ctx.job.id); if (p.sleepMs) await new Promise(r => setTimeout(r, Number(p.sleepMs))); return { ok: true } }, { agentWork: false })
registerJobHandler('test.flaky', async () => { if (failTimes-- > 0) throw new Error('temporary outage'); return { ok: true } }, { agentWork: false, maxAttempts: 3 })
registerJobHandler('test.permanent', async () => { throw new PermanentJobError('bad input') }, { agentWork: false })
registerJobHandler('test.agent', async () => ({ ok: true }), { agentWork: true })

const job = (id: string) => admin(db => db.one<{ status: string; attempts: number; run_after: string; last_error: string | null; lease_owner: string | null; cancel_reason: string | null }>('select status, attempts, run_after, last_error, lease_owner, cancel_reason from jobs where id = $1', [id]))

beforeEach(async () => { ran.length = 0; failTimes = 0; if (ready) { await cleanInfra(); await resetMerchant(NW); await resetMerchant(HB) } })
afterEach(() => { delete process.env.JOBS_PAUSED; delete process.env.JOBS_ORG_CONCURRENCY })
afterAll(async () => { if (ready) await cleanInfra() })

describe.skipIf(!ready)('job queue', () => {
  it('two workers claiming at the same time never run the same job', async () => {
    const ids: string[] = []
    for (let i = 0; i < 24; i++) ids.push((await enqueue({ kind: 'test.record', payload: { sleepMs: 5 } })).id!)
    const [a, b] = await Promise.all([runDueJobs({ workerId: 'wa', kinds: ['test.record'] }), runDueJobs({ workerId: 'wb', kinds: ['test.record'] })])
    expect(a.ran.length + b.ran.length).toBe(24)
    expect(new Set(ran).size).toBe(24)
    expect(ran.length).toBe(24)
    expect([...ran].sort()).toEqual([...ids].sort())
    for (const id of ids) expect((await job(id))!.status).toBe('succeeded')
  })

  it('a crashed worker\'s job is claimed again after its lease expires, and the old worker cannot complete it', async () => {
    const id = (await enqueue({ kind: 'test.record' })).id!
    const first = (await claimNext('crashed', { kinds: ['test.record'] }))!
    expect(first.id).toBe(id)
    // while the lease is live nobody else gets it
    expect(await claimNext('other', { kinds: ['test.record'] })).toBeNull()
    await admin(db => db.query(`update jobs set lease_until = now() - interval '1 second' where id = $1`, [id]))
    const again = (await claimNext('rescuer', { kinds: ['test.record'] }))!
    expect(again).toMatchObject({ id, attempts: 2, lease_owner: 'rescuer' })
    expect(again.last_error).toMatch(/lease expired/)
    expect((await runClaimed(again, 'rescuer')).status).toBe('succeeded')
    // the crashed worker coming back late is refused
    expect((await runClaimed(first, 'crashed')).status).toBe('lost_lease')
    expect((await job(id))!.status).toBe('succeeded')
  })

  it('a lease that expires on the last attempt dead-letters instead of running again', async () => {
    const id = (await enqueue({ kind: 'test.record', maxAttempts: 1 })).id!
    await claimNext('w1', { kinds: ['test.record'] })
    await admin(db => db.query(`update jobs set lease_until = now() - interval '1 second' where id = $1`, [id]))
    expect(await claimNext('w2', { kinds: ['test.record'] })).toBeNull()
    expect((await job(id))!).toMatchObject({ status: 'dead' })
    expect(ran).toEqual([])
  })

  it('failures back off exponentially, then succeed; after max attempts the job is dead and audited', async () => {
    expect([backoffMs(1, 1000, 10_000), backoffMs(2, 1000, 10_000), backoffMs(3, 1000, 10_000), backoffMs(6, 1000, 10_000)]).toEqual([1000, 2000, 4000, 10_000])
    failTimes = 1
    const ok = (await enqueue({ kind: 'test.flaky' })).id!
    const t0 = Date.now()
    await runDueJobs({ kinds: ['test.flaky'] })
    const after1 = (await job(ok))!
    expect(after1).toMatchObject({ status: 'queued', attempts: 1, last_error: 'temporary outage' })
    expect(new Date(after1.run_after).getTime() - t0).toBeGreaterThanOrEqual(29_000)
    expect((await runDueJobs({ kinds: ['test.flaky'] })).ran).toEqual([]) // not due yet
    await runDueJobs({ kinds: ['test.flaky'], now: () => new Date(Date.now() + 31_000) })
    expect((await job(ok))!).toMatchObject({ status: 'succeeded', attempts: 2 })

    failTimes = 99
    const dead = (await enqueue({ kind: 'test.flaky' })).id!
    for (let i = 0; i < 3; i++) await runDueJobs({ kinds: ['test.flaky'], now: () => new Date(Date.now() + (i + 1) * 3600e3) })
    expect((await job(dead))!).toMatchObject({ status: 'dead', attempts: 3 })
    const audit = await admin(db => db.query<{ event: string }>(`select event from engine_audit where entity_type = 'job' and entity_id = $1`, [dead]))
    expect(audit.map(a => a.event)).toEqual(['job.dead'])
    // a permanent error fails at once
    const perm = (await enqueue({ kind: 'test.permanent' })).id!
    await runDueJobs({ kinds: ['test.permanent'] })
    expect((await job(perm))!).toMatchObject({ status: 'failed', attempts: 1, last_error: 'bad input' })
  })

  it('an idempotency key queues one job per organization and kind', async () => {
    const a = await enqueue({ kind: 'test.record', orgId: NW.org, idempotencyKey: 'run-1' })
    const b = await enqueue({ kind: 'test.record', orgId: NW.org, idempotencyKey: 'run-1' })
    const c = await enqueue({ kind: 'test.record', orgId: HB.org, idempotencyKey: 'run-1' })
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ id: a.id, created: false })
    expect(c.created).toBe(true)
    expect(c.id).not.toBe(a.id)
    await runDueJobs({ kinds: ['test.record'] })
    // still deduped after it succeeded
    expect(await enqueue({ kind: 'test.record', orgId: NW.org, idempotencyKey: 'run-1' })).toMatchObject({ id: a.id, created: false, status: 'succeeded' })
  })

  it('at most JOBS_ORG_CONCURRENCY jobs of one organization run at once', async () => {
    process.env.JOBS_ORG_CONCURRENCY = '1'
    await enqueue({ kind: 'test.record', orgId: NW.org })
    const second = (await enqueue({ kind: 'test.record', orgId: NW.org })).id!
    const other = (await enqueue({ kind: 'test.record', orgId: HB.org })).id!
    const a = (await claimNext('w1', { kinds: ['test.record'] }))!
    const b = (await claimNext('w2', { kinds: ['test.record'] }))!
    expect(a.org_id).toBe(NW.org)
    expect(b.id).toBe(other) // NW is at its limit, so the next worker takes Harbor's job
    expect(await claimNext('w3', { kinds: ['test.record'] })).toBeNull()
    await runClaimed(a, 'w1')
    expect((await claimNext('w3', { kinds: ['test.record'] }))!.id).toBe(second)
  })

  it('pause and revoke cancel the agent\'s queued jobs at once; a job that slipped through does nothing', async () => {
    const actor = await merchantActor(NW)
    const id = await grantedAgent(actor, NW, 'Queue watcher')
    const j1 = (await enqueue({ kind: 'agent.run', orgId: NW.org, agentId: id, payload: { agentId: id, orgId: NW.org } })).id!
    expect((await pauseAgent(actor, id)).jobsCancelled).toBe(1)
    expect((await job(j1))!).toMatchObject({ status: 'cancelled', cancel_reason: 'the agent was paused' })
    // a job inserted behind the pause's back is authorized when it runs, and skips
    const sneaky = (await admin(db => db.one<{ id: string }>(`insert into jobs (kind, org_id, agent_id, payload) values ('agent.run', $1, $2, $3) returning id`, [NW.org, id, JSON.stringify({ agentId: id, orgId: NW.org })])))!.id
    const r = await runDueJobs({ kinds: ['agent.run'] })
    expect(r.ran.find(o => o.jobId === sneaky)).toMatchObject({ status: 'succeeded', result: { skipped: true, code: 'agent_inactive' } })
    expect(await admin(db => db.one<{ n: string }>(`select count(*)::text as n from agent_runs where agent_id = $1`, [id]))).toEqual({ n: '0' })
    await resumeAgent(actor, id)
    const j2 = (await enqueue({ kind: 'agent.run', orgId: NW.org, agentId: id, payload: { agentId: id, orgId: NW.org } })).id!
    await revokeAgent(actor, id)
    expect((await job(j2))!.status).toBe('cancelled')
  })

  it('a queued agent run runs the agent once even when the job runs twice', async () => {
    const actor = await merchantActor(NW)
    const id = await grantedAgent(actor, NW, 'Twice')
    await admin(db => db.query(`update agents set next_run_at = now() - interval '1 minute' where id = $1`, [id]))
    const { enqueueDueWork } = await import('../../lib/jobs')
    const q1 = await enqueueDueWork(), q2 = await enqueueDueWork()
    expect(q1.agentRuns.filter(q => q.created)).toHaveLength(1)
    expect(q2.agentRuns.filter(q => q.created)).toHaveLength(0)
    const jobId = q1.agentRuns[0].id!
    expect((await runDueJobs({ kinds: ['agent.run'] })).ran[0]).toMatchObject({ jobId, status: 'succeeded' })
    // simulate the lease expiring and the job being re-run: the agent is no longer due, so it is a recorded skip
    await admin(db => db.query(`update jobs set status = 'queued', run_after = now() where id = $1`, [jobId]))
    const again = (await runDueJobs({ kinds: ['agent.run'] })).ran[0]
    expect(again.result).toMatchObject({ skipped: true, code: 'busy' })
    expect(await admin(db => db.one<{ n: string }>(`select count(*)::text as n from agent_runs where agent_id = $1`, [id]))).toEqual({ n: '1' })
  })

  it('stop all agents: pauses every agent, cancels and refuses agent jobs, refuses grant and resume, is audited; clearing restarts nothing', async () => {
    const actor = await merchantActor(NW)
    const a = await grantedAgent(actor, NW, 'Stop me')
    const queued = (await enqueue({ kind: 'test.agent', orgId: NW.org, agentId: a })).id!
    const housekeeping = (await enqueue({ kind: 'test.record', orgId: NW.org })).id!
    const r = await stopAllAgents(actor, 'incident drill')
    expect(r).toMatchObject({ agentsPaused: 1, jobsCancelled: 1 })
    expect((await job(queued))!.status).toBe('cancelled')
    expect((await job(housekeeping))!.status).toBe('queued') // not agent work
    expect(await admin(db => db.one('select status from agents where id = $1', [a]))).toEqual({ status: 'paused' })
    expect(await enqueue({ kind: 'test.agent', orgId: NW.org })).toMatchObject({ created: false, status: 'refused' })
    await expect(resumeAgent(actor, a)).rejects.toThrow(/stopped/)
    const c = await createAgent(actor, { name: 'New during stop', taskText: '', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'review' } })
    await expect(grantPolicy(actor, c.agentId, c.policyId, c.policyHash)).rejects.toThrow(/stopped/)
    // Harbor is not affected
    expect(await enqueue({ kind: 'test.agent', orgId: HB.org })).toMatchObject({ created: true })
    await expect(stopAllAgents({ kind: 'staff', session: { uid: 'x', email: 'hello@getdeploi.com', role: 'staff', agencyId: null }, label: 'staff:x' }, 'no')).rejects.toThrow(/staff/)
    await clearAgentStop(actor)
    expect(await admin(db => db.one('select status from agents where id = $1', [a]))).toEqual({ status: 'paused' })
    await resumeAgent(actor, a)
    const events = await admin(db => db.query<{ event: string }>(`select event from engine_audit where org_id = $1 and entity_type = 'org' order by id`, [NW.org]))
    expect(events.map(e => e.event).slice(-2)).toEqual(['org.agents_stopped', 'org.agents_stop_cleared'])
  })

  it('cancelJobs needs a scope, and JOBS_PAUSED stops every worker', async () => {
    await expect(admin(db => cancelJobs(db, { reason: 'x', actor: 'test' }))).rejects.toThrow(/organization or an agent/)
    await enqueue({ kind: 'test.record' })
    process.env.JOBS_PAUSED = 'on'
    expect(await runDueJobs({ kinds: ['test.record'] })).toEqual({ paused: true, ran: [] })
    delete process.env.JOBS_PAUSED
    expect((await runDueJobs({ kinds: ['test.record'] })).ran).toHaveLength(1)
  })
})
