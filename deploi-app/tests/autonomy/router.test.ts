/** Event router: dedupe, one durable job per handler, retries with backoff, outcomes, stopped organizations, the sweep. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { onEvent, offEvent, routeEvent, emitSweep, sweepSlot, handleStoredEvent, handlersFor, EVENT_JOB, type AgentEvent } from '../../lib/events'
import '../../lib/events/agents' // every pack's handlers, as the worker loads them
import { runDueJobs } from '../../lib/jobs'
import { NW, HB } from '../merchant/helpers'
import { cleanW1 } from './helpers'

const ready = await prepareDb()
const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({ source: 'manual', type: 'w1.test', orgId: NW.org, externalId: `x-${Math.random().toString(36).slice(2)}`, occurredAt: new Date().toISOString(), payload: { n: 1 }, ...over })
const eventRow = (id: string) => admin(db => db.one<{ status: string; duplicates: number; handlers: string[]; outcomes: Record<string, { status: string; attempts: number; error?: string }> }>('select status, duplicates, handlers, outcomes from agent_events where id = $1', [id]))
const jobsFor = (eventId: string) => admin(db => db.query<{ id: string; status: string; attempts: number; run_after: string; last_error: string | null }>(`select id, status, attempts, run_after, last_error from jobs where kind = $1 and payload->>'eventId' = $2 order by created_at`, [EVENT_JOB, eventId]))

describe('event validation (no database needed)', () => {
  it('refuses events without a known source, a valid type, an organization or a dedupe id', async () => {
    await expect(routeEvent(ev({ source: 'fax' as never }))).rejects.toThrow(/unknown event source/)
    await expect(routeEvent(ev({ type: 'Bad Type' }))).rejects.toThrow(/invalid event type/)
    await expect(routeEvent(ev({ orgId: 'nope' }))).rejects.toThrow(/organization/)
    await expect(routeEvent(ev({ externalId: ' ' }))).rejects.toThrow(/dedupe/)
  })
})

describe.skipIf(!ready)('routeEvent', () => {
  const calls: AgentEvent[] = []
  let failures = 0
  beforeEach(async () => {
    await cleanW1()
    calls.length = 0; failures = 0
    onEvent('w1.test', 'w1-agent-a', async (_db, e) => { calls.push(e); if (failures > 0) { failures--; throw new Error('provider timed out') } })
    onEvent('w1.test', 'w1-agent-b', async (_db, e) => { calls.push({ ...e, type: 'b:' + e.type }) })
  })
  afterAll(async () => { offEvent('w1.test', 'w1-agent-a'); offEvent('w1.test', 'w1-agent-b'); offEvent('*', 'w1-sweeper'); await cleanW1() })

  it('the same event delivered twice is recorded once, as a duplicate the second time, and queues one job per handler', async () => {
    const e = ev({ externalId: 'delivery-1' })
    const first = await routeEvent(e)
    const expected = [...new Set(handlersFor('w1.test').map(h => h.agentKey))]
    expect(expected.slice(0, 2)).toEqual(['w1-agent-a', 'w1-agent-b'])
    expect(first).toMatchObject({ status: 'routed', handlers: expected })
    expect(first.jobs).toHaveLength(expected.length)
    const second = await routeEvent({ ...e, payload: { n: 2 } })
    expect(second).toMatchObject({ status: 'duplicate', eventId: first.eventId, jobs: [] })
    expect(await eventRow(first.eventId)).toMatchObject({ status: 'routed', duplicates: 1 })
    expect(await jobsFor(first.eventId)).toHaveLength(expected.length)
    // the same external id from another source or another organization is a different event
    expect((await routeEvent({ ...e, source: 'crm' })).status).toBe('routed')
    expect((await routeEvent({ ...e, orgId: HB.org })).status).toBe('routed')
    const ran = await runDueJobs({ kinds: [EVENT_JOB] })
    expect(ran.ran.filter(r => r.status === 'succeeded')).toHaveLength(3 * expected.length)
    // each handler saw the first payload once
    expect(calls.filter(c => c.externalId === 'delivery-1' && c.source === 'manual' && c.orgId === NW.org).map(c => [c.type, c.payload.n])).toEqual([['w1.test', 1], ['b:w1.test', 1]])
    const row = await eventRow(first.eventId)
    expect(row!.outcomes['w1-agent-a']).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect(row!.outcomes['w1-agent-b']).toMatchObject({ status: 'succeeded', attempts: 1 })
  })

  it('a handler that throws is retried with backoff and its outcome recorded per attempt', async () => {
    failures = 2
    const r = await routeEvent(ev())
    const t0 = Date.now()
    let now = new Date(t0)
    await runDueJobs({ kinds: [EVENT_JOB], now: () => now })
    let jobs = await jobsFor(r.eventId)
    const a = jobs.find(j => j.status === 'queued')!
    expect(a).toMatchObject({ attempts: 1, last_error: 'provider timed out' })
    expect(new Date(a.run_after).getTime()).toBeGreaterThan(t0 + 20_000) // backoff, not at once
    expect((await eventRow(r.eventId))!.outcomes['w1-agent-a']).toMatchObject({ status: 'failed', attempts: 1, error: 'provider timed out' })
    // not due yet: nothing runs
    expect((await runDueJobs({ kinds: [EVENT_JOB], now: () => now })).ran).toHaveLength(0)
    now = new Date(t0 + 3600e3)
    await runDueJobs({ kinds: [EVENT_JOB], now: () => now })
    now = new Date(t0 + 4 * 3600e3)
    await runDueJobs({ kinds: [EVENT_JOB], now: () => now })
    jobs = await jobsFor(r.eventId)
    expect(jobs.every(j => j.status === 'succeeded')).toBe(true)
    expect((await eventRow(r.eventId))!.outcomes['w1-agent-a']).toMatchObject({ status: 'succeeded', attempts: 3 })
    expect(calls.filter(c => c.type === 'w1.test')).toHaveLength(3)
  })

  it('an event nobody listens to is recorded without jobs; a stopped organization records it as refused', async () => {
    const none = await routeEvent(ev({ type: 'w1.nobody' }))
    if (!handlersFor('w1.nobody').length) expect(none).toMatchObject({ status: 'no_handlers', jobs: [] })
    await admin(db => db.query(`insert into org_controls (org_id, agents_stopped, stop_reason, stopped_by, stopped_at) values ($1, true, 'test', 'test', now())`, [HB.org]))
    const refused = await routeEvent(ev({ orgId: HB.org }))
    expect(refused).toMatchObject({ status: 'refused', jobs: [] })
    expect(await eventRow(refused.eventId)).toMatchObject({ status: 'refused', handlers: [] })
  })

  it('a job runs only for its own organization', async () => {
    const r = await routeEvent(ev())
    expect(await handleStoredEvent(r.eventId, 'w1-agent-a', HB.org)).toMatchObject({ skipped: true, reason: expect.stringMatching(/another organization/) })
    expect(calls).toHaveLength(0)
  })

  it('the sweep emits one event per active organization per 15-minute window, and every "*" handler gets it', async () => {
    const swept: string[] = []
    onEvent('*', 'w1-sweeper', async (_db, e) => { if (e.type === 'sweep') swept.push(e.orgId) })
    await admin(db => db.query(`insert into org_controls (org_id, agents_stopped, stop_reason, stopped_by, stopped_at) values ($1, true, 'test', 'test', now())`, [HB.org]))
    const at = new Date('2026-11-07T10:07:00Z')
    const active = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from agencies a left join org_controls c on c.org_id = a.id where a.org_type = 'merchant' and a.deleted_at is null and not coalesce(c.agents_stopped, false)`))
    const s1 = await emitSweep(at)
    expect(s1).toMatchObject({ slot: '2026-11-07T10:00:00.000Z', orgs: active!.n, routed: active!.n, duplicates: 0 })
    expect(s1.jobs).toBe(active!.n * new Set(handlersFor('sweep').map(h => h.agentKey)).size) // one job per organization and sweep handler
    // an overlapping call in the same window queues nothing
    expect(await emitSweep(new Date('2026-11-07T10:14:59Z'))).toMatchObject({ routed: 0, duplicates: active!.n, jobs: 0 })
    expect(sweepSlot(new Date('2026-11-07T10:15:00Z'))).toBe('2026-11-07T10:15:00.000Z')
    await runDueJobs({ kinds: [EVENT_JOB], limit: 500 })
    expect(swept).toContain(NW.org)
    expect(swept).not.toContain(HB.org) // stopped: no sweep
    expect(new Set(swept).size).toBe(swept.length)
    offEvent('*', 'w1-sweeper')
  })
})
