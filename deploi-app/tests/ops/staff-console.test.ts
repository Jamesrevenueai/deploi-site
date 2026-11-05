/**
 * Staff operations console: queue state and dead jobs with requeue/cancel (audited), the per-organization view,
 * stopping and clearing an organization's agents on the customer's behalf (stop, never grant: agents stay
 * paused), case search by reference, alert acknowledgement, the global switches with instructions, and
 * operational logs correlated by job, case and organization with personal details masked.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { NW, HB, merchantActor, staffActor, resetMerchant } from '../merchant/helpers'
import { grantedAgent, cleanInfra } from '../infra/helpers'
import { acknowledgeAlert, cancelJob, findCaseByRef, globalSwitches, listOrgs, orgOverview, queueOverview, requeueJob, staffClearOrgStop, staffStopOrg } from '../../lib/ops/staff'
import { evaluateAlerts } from '../../lib/ops/alerts'
import { setOpsNotifier, recordingNotifier } from '../../lib/ops/notify'
import { maskText, queryOpsLogs, writeOpsLog } from '../../lib/ops/logs'
import { enqueue, registerJobHandler, runDueJobs } from '../../lib/jobs'
import { openCase, transitionCase } from '../../lib/cases'
import { resumeAgent } from '../../lib/agents/lifecycle'
import { orgStopReason } from '../../lib/engine/kill-switch'

const ready = await prepareDb()
let fails = 0
registerJobHandler('test.ops_fail', async () => { if (fails-- > 0) throw new Error('provider said no to owner@northwind-goods.example'); return { ok: true } }, { agentWork: false, maxAttempts: 1 })

/** the audit trail is append-only: each test reads only what it wrote */
let since = new Date().toISOString()
const audits = (event: string) => admin(db => db.query<{ actor: string; org_id: string | null; entity_id: string | null; detail: Record<string, unknown> }>(`select actor, org_id, entity_id, detail from engine_audit where event = $1 and at >= $2 order by id`, [event, since]))
async function clean() {
  await cleanInfra()
  await admin(async db => {
    await db.query(`delete from jobs where kind like 'test.ops%'`)
    await db.query(`delete from alerts`)
    await db.query(`delete from ops_logs where event like 'test.%' or event like 'staff.%' or event like 'job.%'`)
    await db.query(`delete from cases where org_id = any($1) and kind = 'ops_test'`, [[NW.org, HB.org]])
  })
}
beforeEach(async () => { fails = 0; since = new Date().toISOString(); if (ready) { await clean(); await resetMerchant(NW); await resetMerchant(HB) } setOpsNotifier(recordingNotifier()) })
afterAll(async () => { setOpsNotifier(null); if (ready) await clean() })

describe.skipIf(!ready)('staff operations console', () => {
  it('a dead job is listed, requeued (fresh attempts) and runs; another is cancelled; both actions audited; merchants are refused', async () => {
    const staff = await staffActor(), owner = await merchantActor(NW)
    fails = 1
    const id = (await enqueue({ kind: 'test.ops_fail', orgId: NW.org }))!.id!
    await runDueJobs({ kinds: ['test.ops_fail'] })
    const q = await admin(db => queueOverview(db))
    const dead = q.dead.find(j => j.id === id)!
    expect(dead).toMatchObject({ status: 'dead', kind: 'test.ops_fail', org_name: expect.any(String) })
    // the error text is shown with the address masked
    expect(dead.last_error).toBe('provider said no to [email]@northwind-goods.example')
    await expect(requeueJob(owner, id)).rejects.toMatchObject({ code: 'forbidden' })
    await requeueJob(staff, id, 'provider fixed')
    expect(await admin(db => db.one('select status, attempts from jobs where id = $1', [id]))).toEqual({ status: 'queued', attempts: 0 })
    await runDueJobs({ kinds: ['test.ops_fail'] })
    expect((await admin(db => db.one<{ status: string }>('select status from jobs where id = $1', [id])))!.status).toBe('succeeded')
    await expect(requeueJob(staff, id)).rejects.toMatchObject({ code: 'not_pending' })
    expect(await audits('job.requeued_by_staff')).toEqual([expect.objectContaining({ actor: staff.label, org_id: NW.org, entity_id: id, detail: expect.objectContaining({ previous_status: 'dead', reason: 'provider fixed' }) })])

    fails = 1
    const id2 = (await enqueue({ kind: 'test.ops_fail', orgId: NW.org, idempotencyKey: 'second' }))!.id!
    await runDueJobs({ kinds: ['test.ops_fail'] })
    await cancelJob(staff, id2, 'not needed')
    expect((await admin(db => db.one<{ status: string }>('select status from jobs where id = $1', [id2])))!.status).toBe('cancelled')
    expect(await audits('job.cancelled_by_staff')).toHaveLength(1)
    // every attempt left a correlated log row: job id, organization, outcome
    const logs = await admin(db => queryOpsLogs(db, { jobId: id }))
    expect(logs.map(l => l.event).sort()).toEqual(['job.dead', 'job.succeeded', 'staff.job_requeued'])
    expect(logs.every(l => l.org_id === NW.org && l.job_id === id)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('owner@northwind-goods.example')
  })

  it('staff stop an organization on the customer\'s behalf; turning the stop off restarts nothing (no grant)', async () => {
    const staff = await staffActor(), owner = await merchantActor(NW)
    const agentId = await grantedAgent(owner, NW, 'Watcher')
    await expect(staffStopOrg(staff, NW.org, '')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(staffStopOrg(owner, NW.org, 'x')).rejects.toMatchObject({ code: 'forbidden' })
    const r = await staffStopOrg(staff, NW.org, 'runaway sends reported')
    expect(r.agentsPaused).toBeGreaterThanOrEqual(1)
    expect(await admin(db => orgStopReason(db, NW.org))).toMatch(/stopped by Deploi support: runaway sends reported/)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [agentId])))!.status).toBe('paused')
    const ov = await admin(db => orgOverview(db, NW.org))
    expect(ov.control).toMatchObject({ agents_stopped: true, stopped_by: staff.label })
    expect(ov.agents.find(a => a.id === agentId)).toMatchObject({ status: 'paused' })
    await staffClearOrgStop(staff, NW.org, 'resolved')
    expect(await admin(db => orgStopReason(db, NW.org))).toBeNull()
    // still paused: only the customer resumes (and staff cannot)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [agentId])))!.status).toBe('paused')
    await expect(resumeAgent(staff, agentId)).rejects.toBeTruthy()
    await resumeAgent(owner, agentId)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [agentId])))!.status).toBe('active')
    expect((await audits('org.agents_stopped_by_staff'))[0]).toMatchObject({ actor: staff.label, org_id: NW.org, detail: expect.objectContaining({ on_behalf_of: 'customer' }) })
    expect((await audits('org.agents_stop_cleared_by_staff'))[0]).toMatchObject({ actor: staff.label, detail: expect.objectContaining({ agents_resumed: 0 }) })
    await expect(staffClearOrgStop(staff, NW.org)).rejects.toMatchObject({ code: 'not_pending' })
  })

  it('per-organization view: agents, cases by status, recent failures; the org list counts what needs attention', async () => {
    const c = (await admin(db => openCase(db, { orgId: NW.org, suite: 'commerce', kind: 'ops_test', sourceApp: 'import', dedupeKey: 'ops_test:view', title: 'View test', problem: 'p', verification: { criteria: 'c' }, actor: 'test' }))).case
    await admin(db => transitionCase(db, c.id, { to: 'failed', actor: 'test', reason: 'the supplier mailbox rejected sales@supplier.example' }))
    const ov = await admin(db => orgOverview(db, NW.org))
    expect(ov.casesByStatus.failed).toBeGreaterThanOrEqual(1)
    expect(ov.recentFailures.find(f => f.ref === c.ref)).toMatchObject({ status: 'failed', status_reason: 'the supplier mailbox rejected [email]@supplier.example' })
    const orgs = await admin(db => listOrgs(db, 'north'))
    expect(orgs.find(o => o.id === NW.org)).toMatchObject({ attention: expect.any(Number) })
    expect(orgs.some(o => o.id === HB.org)).toBe(false)
  })

  it('case search by reference returns the case and its correlated history, masked', async () => {
    const c = (await admin(db => openCase(db, { orgId: NW.org, suite: 'office', kind: 'ops_test', sourceApp: 'import', dedupeKey: 'ops_test:find', title: 'Reply to jane@customer.example', problem: 'p', verification: { criteria: 'c' }, actor: 'test' }))).case
    await writeOpsLog({ event: 'test.case_step', orgId: NW.org, caseId: c.id, summary: 'called +1 (415) 555-0100 for jane@customer.example', detail: { email: 'jane@customer.example', count: 2 } })
    const found = await admin(db => findCaseByRef(db, c.ref.toLowerCase()))
    expect(found!.case).toMatchObject({ ref: c.ref, title: 'Reply to [email]@customer.example' })
    const step = found!.logs.find(l => l.event === 'test.case_step')!
    expect(step).toMatchObject({ case_ref: c.ref, org_id: NW.org, summary: 'called [phone] for [email]@customer.example', detail: { email: '[redacted]', count: 2 } })
    expect(found!.logs.some(l => l.source === 'case' && l.event === 'case.opened')).toBe(true)
    expect(await admin(db => findCaseByRef(db, 'DC-999999999'))).toBeNull()
    expect(await admin(db => findCaseByRef(db, "x' or 1=1"))).toBeNull()
    // through RLS: the owning organization sees its logs, another organization none, staff all
    expect((await withUser(SESSIONS.northwind, db => queryOpsLogs(db, { caseRef: c.ref }))).length).toBeGreaterThan(0)
    expect(await withUser(SESSIONS.harbor, db => queryOpsLogs(db, { caseRef: c.ref }))).toEqual([])
    expect((await withUser(SESSIONS.staff, db => queryOpsLogs(db, { caseRef: c.ref }))).length).toBeGreaterThan(0)
  })

  it('alerts are acknowledged by staff only, once, audited; they stay live until the condition clears', async () => {
    const staff = await staffActor(), owner = await merchantActor(NW)
    await admin(db => db.query(`insert into jobs (kind, status, attempts, max_attempts, finished_at) values ('test.ops_dead', 'dead', 1, 1, now())`))
    const { opened: [id] } = await evaluateAlerts({ rules: ['jobs.dead'] })
    await expect(acknowledgeAlert(owner, id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await acknowledgeAlert(staff, id)).toMatchObject({ status: 'acknowledged', acknowledged_by: staff.label })
    await expect(acknowledgeAlert(staff, id)).rejects.toMatchObject({ code: 'not_pending' })
    expect(await evaluateAlerts({ rules: ['jobs.dead'] })).toMatchObject({ updated: [id] })
    expect((await admin(db => db.one<{ status: string }>('select status from alerts where id = $1', [id])))!.status).toBe('acknowledged')
    expect(await audits('alert.acknowledged')).toHaveLength(1)
    await admin(db => db.query(`delete from jobs where kind = 'test.ops_dead'`))
    expect((await evaluateAlerts({ rules: ['jobs.dead'] })).resolved).toEqual([id])
  })

  it('global switches show their state and exactly what to do', () => {
    expect(globalSwitches({})).toMatchObject({ jobsPaused: false, liveWrites: 'on' })
    const on = globalSwitches({ JOBS_PAUSED: 'on', LIVE_WRITES: 'off' })
    expect(on).toMatchObject({ jobsPaused: true, liveWrites: 'off' })
    expect(on.instructions.jobsPaused).toMatch(/JOBS_PAUSED to off .* Redeploy/)
    expect(on.instructions.liveWrites).toMatch(/LIVE_WRITES to on/)
  })

  it('the staff console module offers no way to approve, grant or resume anything', async () => {
    const mod = await import('../../lib/ops/staff')
    expect(Object.keys(mod).filter(k => /approve|grant|resume|reject|decide/i.test(k))).toEqual([])
    const actions = await import('node:fs').then(fs => fs.readFileSync('app/staff/ops/actions.ts', 'utf8'))
    expect(actions).not.toMatch(/\b(approve\w*|grantPolicy|resumeAgent|decide\w*)\(/)
  })

  it('maskText masks addresses and phone numbers, not dates or ids', () => {
    expect(maskText('mail a.b@x.example or +44 20 7946 0958 by 2026-11-20, case DC-000123')).toBe('mail [email]@x.example or [phone] by 2026-11-20, case DC-000123')
  })
})
