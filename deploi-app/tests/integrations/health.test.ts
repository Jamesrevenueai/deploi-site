/**
 * The connection.health job: due probes only, exponential backoff after failures, a flip to error after
 * three failures in a row, needs_reauth at once on an authorization failure, clean transition rows
 * (previous_status -> status) for operations alerting, history pruning, and one queued run per hour.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { runHealthChecks, enqueueHealthWork, HISTORY_DAYS } from '../../lib/integrations/health'
import { nextStatus } from '../../lib/integrations/check'
import { nextProbeDelayMs } from '../../lib/integrations/events'
import { registeredJobKinds } from '../../lib/jobs'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { injectOfficeFault, mutateOfficeSynth } from '../../lib/office/synthetic'
import { resetOffice } from '../office/helpers'
import { merchantActor } from '../merchant/helpers'
import { HB, cleanIntegrations } from './helpers'

const ready = await prepareDb()
const H = 3600e3
type Row = { previous_status: string | null; status: string; ok: boolean; code: string | null; trigger: string }
const history = (id: string) => admin(db => db.query<Row>('select previous_status, status, ok, code, trigger from connection_health where connection_id = $1 order by checked_at, id', [id]))
const state = (id: string) => admin(db => db.one<{ status: string; consecutive_failures: number; next_probe_at: string; last_success_at: string | null; last_error_code: string | null }>('select status, consecutive_failures, next_probe_at, last_success_at, last_error_code from connection_health_state where connection_id = $1', [id]))

describe('health rules (pure)', () => {
  it('backoff doubles from an hour after each failure, at most a day', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(n => nextProbeDelayMs(n) / H)).toEqual([1, 1, 2, 4, 8, 16, 24, 24])
  })
  it('success connects; authorization failures need reauth at once; other failures flip to error on the third', () => {
    expect(nextStatus('error', { ok: true, code: null }, 0)).toBe('connected')
    expect(nextStatus('connected', { ok: false, code: 'auth' }, 1)).toBe('needs_reauth')
    expect(nextStatus('connected', { ok: false, code: 'forbidden' }, 1)).toBe('needs_reauth')
    expect(nextStatus('connected', { ok: false, code: 'server' }, 2)).toBe('connected')
    expect(nextStatus('connected', { ok: false, code: 'timeout' }, 3)).toBe('error')
    expect(nextStatus('needs_reauth', { ok: false, code: 'network' }, 1)).toBe('needs_reauth')
  })
})

describe.skipIf(!ready)('connection.health job', () => {
  beforeEach(async () => { await cleanIntegrations(); await resetOffice(HB) })
  afterAll(async () => { if (ready) { await cleanIntegrations(); await resetOffice(HB, { enable: false }); await admin(db => db.query(`delete from jobs where kind = 'connection.health'`)) } })

  it('is registered on the queue and queued once per hour', async () => {
    expect(registeredJobKinds()).toContain('connection.health')
    const at = new Date('2026-11-05T10:05:00Z')
    const a = await enqueueHealthWork(at), b = await enqueueHealthWork(new Date('2026-11-05T10:55:00Z')), c = await enqueueHealthWork(new Date('2026-11-05T11:01:00Z'))
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ id: a.id, created: false })
    expect(c.created).toBe(true)
    await admin(db => db.query(`delete from jobs where kind = 'connection.health'`))
  })

  it('backs off after failures, flips to error on the third, records each transition once, and recovers', async () => {
    const actor = await merchantActor(HB)
    const c = await connectSyntheticOffice(actor, 'google_calendar', { timezone: 'UTC' })
    const T = new Date('2026-11-05T09:00:00Z')
    const run = (at: Date) => runHealthChecks({ now: at, orgIds: [HB.org], keys: ['google_calendar'] })

    expect(await run(T)).toMatchObject({ probed: 1, ok: 1, failed: 0 })
    expect(await state(c.id)).toMatchObject({ status: 'connected', consecutive_failures: 0 })
    expect(new Date((await state(c.id))!.next_probe_at).getTime()).toBe(T.getTime() + H)
    // not due yet: nothing is probed
    expect(await run(new Date(T.getTime() + 30 * 60e3))).toMatchObject({ probed: 0, skippedNotDue: 1 })

    await injectOfficeFault(c.id, { op: '*', mode: 'server_error', remaining: 3 })
    const t1 = new Date(T.getTime() + H)
    expect(await run(t1)).toMatchObject({ probed: 1, failed: 1, transitions: 0 })
    let s = (await state(c.id))!
    expect(s).toMatchObject({ status: 'connected', consecutive_failures: 1, last_error_code: 'server' })
    expect(new Date(s.next_probe_at).getTime()).toBe(t1.getTime() + H)
    const t2 = new Date(t1.getTime() + H)
    await run(t2)
    s = (await state(c.id))!
    expect(s).toMatchObject({ status: 'connected', consecutive_failures: 2 })
    expect(new Date(s.next_probe_at).getTime()).toBe(t2.getTime() + 2 * H)
    // an hour later it is still backing off
    expect(await run(new Date(t2.getTime() + H))).toMatchObject({ probed: 0 })
    const t3 = new Date(t2.getTime() + 2 * H)
    expect(await run(t3)).toMatchObject({ probed: 1, transitions: 1 })
    s = (await state(c.id))!
    expect(s).toMatchObject({ status: 'error', consecutive_failures: 3 })
    expect(new Date(s.next_probe_at).getTime()).toBe(t3.getTime() + 4 * H)
    // the faults are spent: the next due probe succeeds and recovers
    const t4 = new Date(t3.getTime() + 4 * H)
    expect(await run(t4)).toMatchObject({ probed: 1, ok: 1, transitions: 1 })
    expect(await state(c.id)).toMatchObject({ status: 'connected', consecutive_failures: 0, last_success_at: expect.anything() })

    const h = await history(c.id)
    expect(h.map(r => [r.previous_status, r.status, r.ok, r.code])).toEqual([
      ['connected', 'connected', true, null],
      ['connected', 'connected', false, 'server'],
      ['connected', 'connected', false, 'server'],
      ['connected', 'error', false, 'server'],
      ['error', 'connected', true, null],
    ])
    expect(h.every(r => r.trigger === 'schedule')).toBe(true)
    // exactly the two transitions operations alerting would act on
    expect(h.filter(r => r.previous_status !== r.status)).toHaveLength(2)
  })

  it('an authorization failure needs reauth at once and marks the connection itself', async () => {
    const actor = await merchantActor(HB)
    const c = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    const { injectQboFault } = await import('../../lib/office/quickbooks-synthetic')
    await injectQboFault(c.id, { op: '*', mode: 'auth', remaining: 10 })
    const r = await runHealthChecks({ now: new Date(), orgIds: [HB.org], keys: ['quickbooks'] })
    expect(r).toMatchObject({ probed: 1, failed: 1, transitions: 1 })
    expect(await state(c.id)).toMatchObject({ status: 'needs_reauth', consecutive_failures: 1, last_error_code: 'auth' })
    expect(await admin(db => db.one('select status from office_connections where id = $1', [c.id]))).toEqual({ status: 'needs_reauth' })
    expect((await history(c.id)).map(x => [x.previous_status, x.status])).toEqual([['connected', 'needs_reauth']])
  })

  it('only due connections of the organizations asked for are probed; history older than the retention window is pruned', async () => {
    const actor = await merchantActor(HB)
    const c = await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
    await mutateOfficeSynth(c.id, s => { s.calls = [] })
    await admin(db => db.query(`insert into connection_health (org_id, integration, connection_id, ok, status, message, checked_at) values ($1, 'hubspot', $2, true, 'connected', 'old', now() - make_interval(days => $3))`, [HB.org, c.id, HISTORY_DAYS + 1]))
    const r = await runHealthChecks({ orgIds: [HB.org], keys: ['hubspot'] })
    expect(r).toMatchObject({ probed: 1, ok: 1 })
    expect(r.pruned).toBeGreaterThanOrEqual(1)
    expect((await history(c.id)).length).toBe(1)
    expect(await runHealthChecks({ orgIds: ['00000000-0000-4000-8000-000000000000'] })).toMatchObject({ probed: 0 })
  })
})
