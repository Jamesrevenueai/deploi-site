/**
 * Reliability campaign: the shared runtime (job queue, Resolution Engine checks, store executions, email sends,
 * approvals) under concurrency, interruptions, duplicate and out-of-order events, and unauthorized attempts.
 * Every case checks what the customer would see: one send, one write, one decision, the right status.
 *
 * Defects reproduced here and fixed in place (see the notes in the code):
 *   R-1  two case.check jobs for the same case (different due times) ran its checker twice at once
 *        -> lib/cases/index.ts runCaseCheck claims the check (next_check_at moved forward atomically) first
 *   R-2  a job's payload could name another organization's case, message or agent and act on it under the
 *        job's organization -> lib/cases/jobs.ts and lib/jobs/handlers.ts refuse ids outside the job's organization
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB, merchantActor, staffActor, resetMerchant, store } from '../merchant/helpers'
import { grantedAgent, cleanInfra } from '../infra/helpers'
import { fakeResend, restoreEmail, chaser, SUPPLIER, DOMAIN, sent } from '../infra/email-env'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { claimNext, enqueue, runClaimed, runDueJobs } from '../../lib/jobs'
import '../../lib/cases/jobs'
import { openCase, registerCaseKind, resolveCase, runCaseCheck, type CaseRow } from '../../lib/cases'
import { runAgent } from '../../lib/agents/run'
import { pauseAgent, revokeAgent } from '../../lib/agents/lifecycle'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal, retryExecution } from '../../lib/engine/execute'
import { recoverInterruptedExecutions } from '../../lib/engine/recover'
import { approveMessage, createAgentMessages } from '../../lib/email/engine'
import { processInbound } from '../../lib/email/inbound'
import { decideApproval, listPendingApprovals } from '../../lib/approvals'
import type { ProposalRow } from '../../lib/engine/proposals'

const ready = await prepareDb()

// a case kind whose checker records how many checks run at once
let running = 0, maxRunning = 0, checks = 0
registerCaseKind('rel_test', async c => {
  running++; checks++; maxRunning = Math.max(maxRunning, running)
  await new Promise(r => setTimeout(r, 150))
  running--
  await admin(db => db.query(`update cases set next_check_at = now() + interval '1 day' where id = $1`, [c.id]))
})

async function relCase(m: typeof NW, key = randomUUID()) {
  const c = (await admin(db => openCase(db, { orgId: m.org, suite: 'commerce', kind: 'rel_test', sourceApp: 'import', dedupeKey: `rel_test:${key}`, title: 'Reliability', problem: 'p', verification: { criteria: 'observed' }, actor: 'test', nextCheckAt: new Date(Date.now() - 60_000) }))).case
  return c
}
const caseRow = (id: string) => admin(db => db.one<CaseRow>('select * from cases where id = $1', [id])).then(r => r!)
const job = (id: string) => admin(db => db.one<{ status: string; result: Record<string, unknown> | null }>('select status, result from jobs where id = $1', [id])).then(r => r!)

async function clean() {
  await cleanInfra()
  await admin(async db => {
    await db.query(`delete from jobs where kind in ('case.check','agent.run','email.send')`)
    await db.query(`delete from cases where kind = 'rel_test'`)
  })
}
beforeEach(async () => { running = 0; maxRunning = 0; checks = 0; fakeResend(); if (ready) { await clean(); await resetMerchant(NW); await resetMerchant(HB) } })
afterEach(restoreEmail)
afterAll(async () => { if (ready) { await clean(); await resetMerchant(NW); await resetMerchant(HB) } })

describe.skipIf(!ready)('concurrency', () => {
  it('R-1: two workers checking the same case at once run its checker once', async () => {
    const c = await relCase(NW)
    // two jobs for the same case (queued for two different due times by overlapping sweeps)
    await enqueue({ kind: 'case.check', orgId: NW.org, payload: { caseId: c.id }, idempotencyKey: `${c.id}@a` })
    await enqueue({ kind: 'case.check', orgId: NW.org, payload: { caseId: c.id }, idempotencyKey: `${c.id}@b` })
    const [a, b] = await Promise.all([runDueJobs({ workerId: 'wa', kinds: ['case.check'] }), runDueJobs({ workerId: 'wb', kinds: ['case.check'] })])
    const all = [...a.ran, ...b.ran]
    expect(all).toHaveLength(2)
    expect(all.every(o => o.status === 'succeeded')).toBe(true)
    expect(checks).toBe(1)
    expect(maxRunning).toBe(1)
    expect(all.map(o => o.result?.status).sort()).toEqual(['detected', 'skipped'])
    expect(new Date((await caseRow(c.id)).next_check_at!).getTime()).toBeGreaterThan(Date.now() + 23 * 3600e3)
  })

  it('a checker that throws gives its check back: the next attempt runs it', async () => {
    let fail = true
    registerCaseKind('rel_test_fail', async c => { if (fail) { fail = false; throw new Error('provider 503') } await admin(db => db.query(`update cases set next_check_at = null where id = $1`, [c.id])) })
    const c = (await admin(db => openCase(db, { orgId: NW.org, suite: 'commerce', kind: 'rel_test_fail', sourceApp: 'import', dedupeKey: `rel_test:${randomUUID()}`, title: 'Reliability fail', problem: 'p', verification: { criteria: 'o' }, actor: 'test', nextCheckAt: new Date(Date.now() - 60_000) }))).case
    await expect(runCaseCheck(c.id)).rejects.toThrow(/503/)
    expect(new Date((await caseRow(c.id)).next_check_at!).getTime()).toBeLessThanOrEqual(Date.now())
    expect(await runCaseCheck(c.id)).toMatchObject({ status: 'detected' })
    expect((await caseRow(c.id)).next_check_at).toBeNull()
    await admin(db => db.query(`delete from cases where id = $1`, [c.id]))
  })

  it('two approvals of the same store change at once: one approval, one execution, one write', async () => {
    const owner = await merchantActor(NW)
    const agentId = await grantedAgent(owner, NW, 'Concurrent')
    await runAgent(agentId, { trigger: 'test', actor: owner.label })
    const p = (await admin(db => db.one<ProposalRow>(`select * from proposals where agent_id = $1 and status = 'pending_approval' order by created_at limit 1`, [agentId])))!
    const writes0 = (await store(NW))!.writeLog.length
    const r = await Promise.allSettled([approveProposal(owner, p.id, p.change_hash), approveProposal(owner, p.id, p.change_hash)])
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect((r.find(x => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'not_pending' })
    const ex = await Promise.all([executeProposal(p.id, { actor: 'w1' }), executeProposal(p.id, { actor: 'w2' })])
    expect(new Set(ex.map(e => e.executionId)).size).toBe(1)
    expect(await admin(db => db.query('select id from executions where proposal_id = $1', [p.id]))).toHaveLength(1)
    expect((await store(NW))!.writeLog.length).toBe(writes0 + 1)
  })

  it('two approvals of the same email at once: one send', async () => {
    const owner = await merchantActor(NW)
    const c = await chaser(owner, NW)
    const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `rel-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock', bodyText: 'Please confirm 12.', attachments: [] } }] })
    const id = r.created[0].id
    const hash = (await admin(db => db.one<{ content_hash: string }>('select content_hash from email_messages where id = $1', [id])))!.content_hash
    const out = await Promise.allSettled([approveMessage(owner, id, hash), approveMessage(owner, id, hash)])
    expect(out.some(o => o.status === 'fulfilled' && (o.value as { status: string }).status === 'accepted')).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe.skipIf(!ready)('interruptions', () => {
  it('a crash between the write and its verification: unknown for the merchant, never re-executed by recovery; a retry re-reads first', async () => {
    const owner = await merchantActor(NW)
    const agentId = await grantedAgent(owner, NW, 'Crash')
    await runAgent(agentId, { trigger: 'test', actor: owner.label })
    const p = (await admin(db => db.one<ProposalRow>(`select * from proposals where agent_id = $1 and status = 'pending_approval' order by created_at limit 1`, [agentId])))!
    await approveProposal(owner, p.id, p.change_hash)
    const done = await executeProposal(p.id, { actor: 'worker' })
    expect(done.status).toBe('verified')
    const writes = (await store(NW))!.writeLog.length
    // the worker wrote, then died before recording the verification: the row is left mid-flight
    await admin(db => db.query(`update executions set status = 'executing', finished_at = null, started_at = now() - interval '30 minutes' where id = $1`, [done.executionId]))
    expect(await recoverInterruptedExecutions()).toMatchObject({ resumed: [], markedUnknown: 1 })
    expect((await recoverInterruptedExecutions()).markedUnknown).toBe(0)
    expect(await admin(db => db.one('select status from executions where id = $1', [done.executionId]))).toEqual({ status: 'unknown' })
    expect((await store(NW))!.writeLog.length).toBe(writes)
    // the merchant's retry re-reads the record: the change is already there, so nothing is written twice
    const retry = await retryExecution(owner, done.executionId!)
    expect(['verified', 'stale']).toContain(retry.status)
    expect((await store(NW))!.writeLog.length).toBe(writes)
  })

  it('a lease that expires mid-send: the second worker does not send again, the first worker cannot complete the job', async () => {
    const owner = await merchantActor(NW)
    const c = await chaser(owner, NW)
    const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `rel-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock', bodyText: 'Please confirm 12.', attachments: [] } }] })
    const id = r.created[0].id
    await admin(db => db.query(`update email_messages set status = 'queued', approval_kind = 'individual', approved_hash = content_hash, approved_by = 'test', approved_at = now() where id = $1`, [id]))
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    let posts = 0
    setEmailFetch(async (url, init) => {
      if (url.endsWith('/emails') && init.method === 'POST') { posts++; await gate; return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 }) }
      throw new Error(`unexpected HTTP call in test: ${init.method} ${url}`)
    })
    const jobId = (await enqueue({ kind: 'email.send', orgId: NW.org, agentId: c.agentId, payload: { messageId: id }, idempotencyKey: `rel-${id}` })).id!
    const first = (await claimNext('w1', { kinds: ['email.send'] }))!
    const w1 = runClaimed(first, 'w1')
    await new Promise(res => setTimeout(res, 200))
    expect(posts).toBe(1)
    // the lease runs out while the provider call hangs; a second worker takes the job
    await admin(db => db.query(`update jobs set lease_until = now() - interval '1 second' where id = $1`, [jobId]))
    const second = (await claimNext('w2', { kinds: ['email.send'] }))!
    expect(second.id).toBe(jobId)
    const o2 = await runClaimed(second, 'w2')
    expect(o2.status).toBe('succeeded')
    expect(posts).toBe(1) // the message is already Sending: no second provider call
    release()
    expect((await w1).status).toBe('lost_lease')
    expect(posts).toBe(1)
    expect((await admin(db => db.one<{ status: string }>('select status from email_messages where id = $1', [id])))!.status).toBe('accepted')
  })
})

describe.skipIf(!ready)('duplicate and out-of-order events', () => {
  it('inbound mail delivered twice is stored once and counts as one reply', async () => {
    const owner = await merchantActor(NW)
    const c = await chaser(owner, NW)
    const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `rel-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock', bodyText: 'Please confirm 12.', attachments: [] } }] })
    const m = (await admin(db => db.one<{ content_hash: string; reply_token: string }>('select content_hash, reply_token from email_messages where id = $1', [r.created[0].id])))!
    await approveMessage(owner, r.created[0].id, m.content_hash)
    const to = `${c.mailbox.split('@')[0]}+t-${m.reply_token}@${DOMAIN}`
    const emailId = `in-${randomUUID()}`
    const mail = { id: emailId, from: SUPPLIER, to: [to], cc: [], subject: 'Re: Restock', text: 'Shipping Friday.', messageId: `<${emailId}@supplier.example>`, inReplyTo: null, references: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachmentCount: 0, receivedAt: new Date().toISOString() }
    const deliver = (deliveryId: string) => processInbound({ deliveryId, type: 'email.received', data: { email_id: emailId, to: [to] } }, async () => mail)
    // the same webhook twice (same delivery id), and once more under a new delivery id (a provider retry), two at once
    await Promise.all([deliver(`d-${emailId}`), deliver(`d-${emailId}`)])
    await deliver(`d2-${emailId}`)
    expect(await admin(db => db.query('select id from email_inbound where provider_email_id = $1', [emailId]))).toHaveLength(1)
    expect((await admin(db => db.one<{ reply_count: number }>('select reply_count from email_messages where id = $1', [r.created[0].id])))!.reply_count).toBe(1)
  })

  it('a bounce that arrives before the send is recorded as accepted does not get lost or reversed', async () => {
    const owner = await merchantActor(NW)
    const c = await chaser(owner, NW)
    const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `rel-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock', bodyText: 'x', attachments: [] } }] })
    const id = r.created[0].id
    await approveMessage(owner, id, (await admin(db => db.one<{ content_hash: string }>('select content_hash from email_messages where id = $1', [id])))!.content_hash)
    const pid = (await admin(db => db.one<{ provider_message_id: string }>('select provider_message_id from email_messages where id = $1', [id])))!.provider_message_id
    // bounce first, then a late "delivered"/duplicate acceptance event for the same message
    await processInbound({ deliveryId: `b-${id}`, type: 'email.bounced', data: { email_id: pid, to: [SUPPLIER] } })
    await processInbound({ deliveryId: `b-${id}`, type: 'email.bounced', data: { email_id: pid, to: [SUPPLIER] } })
    await processInbound({ deliveryId: `dl-${id}`, type: 'email.delivered', data: { email_id: pid, to: [SUPPLIER] } }).catch(() => null)
    expect(await admin(db => db.one('select status, failure_code from email_messages where id = $1', [id]))).toEqual({ status: 'failed', failure_code: 'bounced' })
    expect(await admin(db => db.query(`select reason from email_suppressions where org_id = $1 and address = $2`, [NW.org, SUPPLIER]))).toHaveLength(1)
  })

  it('a check that arrives after the case was resolved does nothing (terminal cases never reopen)', async () => {
    const c = await relCase(NW)
    await admin(db => resolveCase(db, c.id, { actor: 'test', summary: 'seen', verifiedBy: 'test', evidence: [{ label: 'observed', source: 'test', observedAt: new Date().toISOString() }] }))
    const id = (await enqueue({ kind: 'case.check', orgId: NW.org, payload: { caseId: c.id }, idempotencyKey: `${c.id}@late` })).id!
    await runDueJobs({ kinds: ['case.check'] })
    expect((await job(id)).result).toMatchObject({ status: 'skipped' })
    expect(checks).toBe(0)
    expect((await caseRow(c.id)).status).toBe('resolved')
  })
})

describe.skipIf(!ready)('unauthorized actions', () => {
  it('a paused or revoked agent\'s queued run does nothing', async () => {
    const owner = await merchantActor(NW)
    // each queued before its pause/revoke (raw rows, as a job that slipped past cancellation would be)
    const queue = (agentId: string) => admin(db => db.one<{ id: string }>(`insert into jobs (kind, org_id, agent_id, payload) values ('agent.run', $1, $2, $3) returning id`, [NW.org, agentId, JSON.stringify({ agentId, orgId: NW.org })])).then(r => r!.id)
    const b = await grantedAgent(owner, NW, 'Revoked')
    const jb = await queue(b)
    await revokeAgent(owner, b)
    const a = await grantedAgent(owner, NW, 'Paused')
    const ja = await queue(a)
    await pauseAgent(owner, a)
    await admin(db => db.query(`update jobs set status = 'queued', cancel_reason = null, finished_at = null where id = any($1)`, [[ja, jb]]))
    const runs0 = await admin(db => db.query('select id from agent_runs where agent_id = any($1)', [[a, b]]))
    await runDueJobs({ kinds: ['agent.run'] })
    expect((await job(ja)).result).toMatchObject({ skipped: true, code: 'agent_inactive' })
    expect((await job(jb)).result).toMatchObject({ skipped: true })
    expect(await admin(db => db.query('select id from agent_runs where agent_id = any($1)', [[a, b]]))).toHaveLength(runs0.length)
  })

  it('R-2: a job cannot act on another organization\'s case, agent or message through ids in its payload', async () => {
    const owner = await merchantActor(NW)
    const nwCase = await relCase(NW)
    const nwAgent = await grantedAgent(owner, NW, 'Victim')
    const c = await chaser(owner, NW)
    const m = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `rel-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock', bodyText: 'x', attachments: [] } }] })
    await admin(db => db.query(`update email_messages set status = 'queued', approval_kind = 'individual', approved_hash = content_hash, approved_by = 'test', approved_at = now() where id = $1`, [m.created[0].id]))
    // jobs of Harbor that name Northwind's records
    const j1 = (await enqueue({ kind: 'case.check', orgId: HB.org, payload: { caseId: nwCase.id }, idempotencyKey: 'x1' })).id!
    const j2 = (await enqueue({ kind: 'agent.run', orgId: HB.org, payload: { agentId: nwAgent, orgId: NW.org, trigger: 'schedule' }, idempotencyKey: 'x2' })).id!
    const j3 = (await enqueue({ kind: 'email.send', orgId: HB.org, payload: { messageId: m.created[0].id }, idempotencyKey: 'x3' })).id!
    const runs0 = (await admin(db => db.query('select id from agent_runs where agent_id = $1', [nwAgent]))).length
    await runDueJobs({ kinds: ['case.check', 'agent.run', 'email.send'] })
    expect((await job(j1)).result).toMatchObject({ skipped: true, reason: expect.stringMatching(/another organization/) })
    expect((await job(j2)).result).toMatchObject({ skipped: true, code: 'wrong_org' })
    expect((await job(j3)).result).toMatchObject({ skipped: true, reason: expect.stringMatching(/another organization/) })
    expect(checks).toBe(0)
    expect((await admin(db => db.query('select id from agent_runs where agent_id = $1', [nwAgent]))).length).toBe(runs0)
    expect(sent).toHaveLength(0)
    // the same jobs for the right organization work
    await enqueue({ kind: 'case.check', orgId: NW.org, payload: { caseId: nwCase.id }, idempotencyKey: 'ok1' })
    await runDueJobs({ kinds: ['case.check'] })
    expect(checks).toBe(1)
  })

  it('an approval with another organization\'s item id is not found; staff can never approve or reject', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB), staff = await staffActor()
    const agentId = await grantedAgent(nw, NW, 'Approvals')
    await runAgent(agentId, { trigger: 'test', actor: nw.label })
    const { items } = await listPendingApprovals(nw)
    const it0 = items.find(i => i.source === 'proposal') ?? items[0]
    expect(it0).toBeTruthy()
    await expect(decideApproval(hb, it0.source, it0.id, 'approve', { version: it0.version })).rejects.toMatchObject({ code: 'not_found' })
    await expect(decideApproval(staff, it0.source, it0.id, 'approve', { version: it0.version })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(decideApproval(staff, it0.source, it0.id, 'reject', { version: it0.version })).rejects.toMatchObject({ code: 'forbidden' })
    const p = (await admin(db => db.one<ProposalRow>(`select * from proposals where agent_id = $1 and status = 'pending_approval' limit 1`, [agentId])))!
    await expect(approveProposal(staff, p.id, p.change_hash)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(approveProposal(hb, p.id, p.change_hash)).rejects.toMatchObject({ code: 'not_found' })
    expect((await admin(db => db.one<{ status: string }>('select status from proposals where id = $1', [p.id])))!.status).toBe('pending_approval')
  })
})
