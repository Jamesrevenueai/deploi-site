/**
 * The agent loop: act_and_tell (act, fresh-read verify, resolve with proof, undo, tell), ask_first (approval in the
 * unified inbox, approve/reject, resume), an owner who never answers (reminder at 24 h, escalation at 72 h),
 * cannot finish (blocked, retries, failed), two agents on one job, idempotent re-runs.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { runAgentLoop, registerLoopResumer, MAX_ATTEMPTS, REMIND_AFTER_MS, ESCALATE_AFTER_MS, LOOP_RESUME_JOB, type LoopSpec } from '../../lib/events/loop'
import { setMode } from '../../lib/autonomy/settings'
import { listPendingApprovals, decideApproval } from '../../lib/approvals'
import { runCaseCheck } from '../../lib/cases'
import '../../lib/cases/jobs'
import { runDueJobs } from '../../lib/jobs'
import { registerUndo } from '../../lib/undo'
import { NW, merchantActor } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { captureNotify, releaseNotify, sent, cleanW1 } from './helpers'

const ready = await prepareDb()

type World = { broken: boolean; acts: number; failAct: number; verifyLies: boolean; slow: number }
let world: World
const fresh = (): World => ({ broken: true, acts: 0, failAct: 0, verifyLies: false, slow: 0 })
registerUndo('w1.test.restore', async (_db, p) => { world.broken = true; return { ok: true, detail: `restored for ${String(p.orgId)}` } })

function spec(over: Partial<LoopSpec<{ id: string }>> = {}): LoopSpec<{ id: string }> {
  return {
    orgId: NW.org, agentKey: 'w1-fixer', agentName: 'Fixer', actionType: 'update_listing', problemKey: 'w1:listing:42',
    detect: async () => (world.broken ? { id: '42' } : null),
    describe: () => ({ title: 'Listing 42 shows the wrong price', whatHappened: 'The price on listing 42 is 0.00.', whatIDid: ['Set the price of listing 42 back to 19.00.'] }),
    act: async () => {
      world.acts++
      if (world.slow) await new Promise(r => setTimeout(r, world.slow))
      if (world.failAct > 0) { world.failAct--; throw new Error('the store refused the change') }
      world.broken = false
      return { undo: { kind: 'w1.test.restore', payload: { listing: '42', orgId: 'someone-else' } }, proof: [{ label: 'Changed', value: 'price 0.00 -> 19.00' }] }
    },
    verify: async () => ({ ok: world.verifyLies ? false : !world.broken, proof: [{ label: 'Fresh read of listing 42', value: world.broken ? 'price 0.00' : 'price 19.00' }] }),
    ...over,
  }
}
const loopRow = (problemKey = 'w1:listing:42') => admin(db => db.one<{ id: string; state: string; case_id: string; attempts: number; asked_at: string; reminded_at: string | null; escalated_at: string | null; undo_token_id: string | null }>(
  'select * from agent_loops where org_id = $1 and problem_key = $2 order by created_at desc limit 1', [NW.org, problemKey]))
const caseRow = (id: string) => admin(db => db.one<{ ref: string; status: string; status_reason: string; approval_required: boolean; outcome: { evidence: { label: string; source: string }[]; verifiedBy: string } | null; next_check_at: string | null }>('select * from cases where id = $1', [id]))
const caseEvents = (id: string) => admin(db => db.query<{ type: string; actor: string; summary: string }>('select type, actor, summary from case_events where case_id = $1 order by id', [id]))
const run = (over: Partial<LoopSpec<{ id: string }>> = {}) => admin(db => runAgentLoop(db, spec(over)))

describe.skipIf(!ready)('runAgentLoop', () => {
  beforeEach(async () => { await cleanW1(); world = fresh(); captureNotify() })
  afterAll(async () => { releaseNotify(); await cleanW1(); await removePeople(NW) })

  it('act_and_tell: acts, verifies with a fresh read, resolves the case with that proof, registers an undo and tells the owner', async () => {
    const out = await run()
    expect(out).toMatchObject({ status: 'done', verified: true, mode: 'act_and_tell', caseRef: expect.stringMatching(/^DC-/), undoToken: expect.stringMatching(/^u_/) })
    expect(world).toMatchObject({ broken: false, acts: 1 })
    const l = (await loopRow())!
    expect(l.state).toBe('done')
    const c = (await caseRow(l.case_id))!
    expect(c.status).toBe('resolved')
    expect(c.outcome!.evidence.map(e => [e.label, e.source])).toEqual([['Fresh read of listing 42: price 19.00', 'fresh_read']])
    expect(c.outcome!.verifiedBy).toBe('Fixer (fresh read)')
    expect((await caseEvents(l.case_id)).map(e => e.type)).toEqual(['opened', 'status', 'action', 'status', 'verification'])
    const undo = await admin(db => db.one<{ id: string; case_id: string; kind: string; used_at: string | null }>('select id, case_id, kind, used_at from undo_tokens where id = $1', [l.undo_token_id]))
    expect(undo).toMatchObject({ case_id: l.case_id, kind: 'w1.test.restore', used_at: null })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ severity: 'info', agentKey: 'w1-fixer', caseRef: c.ref, undoToken: out.status === 'done' ? out.undoToken : null, headline: 'Listing 42 shows the wrong price', detailsPath: `/store/work/${c.ref}` })
    expect(sent[0].proof.map(p => p.label)).toEqual(['Changed', 'Fresh read of listing 42'])
    // idempotent: the fixed problem is not detected again; nothing new happens
    expect(await run()).toEqual({ status: 'nothing_to_do' })
    expect(world.acts).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('ask_first: the exact action waits in the approvals inbox; approving carries it out through the resumer; reject does nothing', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'update_listing', 'ask_first')
    const out = await run()
    expect(out).toMatchObject({ status: 'waiting_for_owner', approvalId: expect.any(String) })
    expect(world.acts).toBe(0)
    const l = (await loopRow())!
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'awaiting_approval', approval_required: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ severity: 'action', whatIDid: ['Prepared this for you; nothing has been done yet.', 'Set the price of listing 42 back to 19.00.'] })
    // a re-run is idempotent: still waiting, nothing new sent
    expect(await run()).toMatchObject({ status: 'waiting_for_owner', approvalId: l.id })
    expect(sent).toHaveLength(1)

    const { items } = await listPendingApprovals(owner, { source: 'agent_action' })
    expect(items).toHaveLength(1)
    const it0 = items[0]
    expect(it0).toMatchObject({ source: 'agent_action', id: l.id, title: 'Listing 42 shows the wrong price', decisions: ['approve', 'reject'],
      content: { actionType: 'update_listing', money: false, whatTheAgentWillDo: ['Set the price of listing 42 back to 19.00.'] } })
    // members cannot approve; a stale version is refused
    const member = await person(NW, 'member', 'w1-loop-member')
    await expect(decideApproval(member, 'agent_action', l.id, 'approve', { version: it0.version })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(decideApproval(owner, 'agent_action', l.id, 'approve', { version: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'hash_mismatch' })

    registerLoopResumer('w1-fixer', async r => (r.problemKey === 'w1:listing:42' ? spec() : null))
    const d = await decideApproval(owner, 'agent_action', l.id, 'approve', { version: it0.version })
    expect(d).toMatchObject({ status: 'approved', jobId: expect.any(String) })
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'executing', approval_required: false })
    await runDueJobs({ kinds: [LOOP_RESUME_JOB] })
    expect(world.acts).toBe(1)
    expect((await loopRow())!.state).toBe('done')
    expect((await caseRow(l.case_id))!.status).toBe('resolved')
    expect(sent.map(s => s.severity)).toEqual(['action', 'info'])
    expect((await listPendingApprovals(owner, { source: 'agent_action' })).items).toHaveLength(0)

    // reject: the next problem is cancelled and nothing is done
    world = fresh()
    await run({ problemKey: 'w1:listing:43' })
    const l2 = (await loopRow('w1:listing:43'))!
    const v2 = (await listPendingApprovals(owner, { source: 'agent_action' })).items[0].version
    expect(await decideApproval(owner, 'agent_action', l2.id, 'reject', { version: v2, reason: 'I will do it myself' })).toMatchObject({ status: 'rejected' })
    expect(world.acts).toBe(0)
    expect((await loopRow('w1:listing:43'))!.state).toBe('rejected')
    expect(await caseRow(l2.case_id)).toMatchObject({ status: 'cancelled' })
  })

  it('without a resumer, an approved action is carried out on the agent\'s next run', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'refund', 'ask_first')
    await run({ agentKey: 'w1-no-resumer', actionType: 'refund', problemKey: 'w1:refund:1' })
    const l = (await loopRow('w1:refund:1'))!
    const item = (await listPendingApprovals(owner, { source: 'agent_action' })).items.find(i => i.id === l.id)!
    expect(item.content).toMatchObject({ money: true })
    await decideApproval(owner, 'agent_action', l.id, 'approve', { version: item.version })
    expect(await runDueJobs({ kinds: [LOOP_RESUME_JOB] })).toMatchObject({ ran: [{ status: 'succeeded', result: { skipped: true } }] })
    expect(world.acts).toBe(0)
    expect(await run({ agentKey: 'w1-no-resumer', actionType: 'refund', problemKey: 'w1:refund:1' })).toMatchObject({ status: 'done', mode: 'ask_first' })
    expect(world.acts).toBe(1)
  })

  it('an owner who never answers gets a reminder at 24 hours, and the case is escalated at 72 hours (still decidable)', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'update_listing', 'ask_first')
    await run()
    const l = (await loopRow())!
    const asked = new Date(l.asked_at).getTime()
    expect(new Date((await caseRow(l.case_id))!.next_check_at!).getTime()).toBe(asked + REMIND_AFTER_MS)
    // before 24 hours: nothing
    expect(await runCaseCheck(l.case_id, new Date(asked + 3600e3))).toMatchObject({ status: 'skipped', reason: 'not due' })
    await runCaseCheck(l.case_id, new Date(asked + REMIND_AFTER_MS + 60e3))
    expect(sent.map(s => s.severity)).toEqual(['action', 'action'])
    expect(sent[1].whatIDid[0]).toMatch(/^Reminder/)
    expect(sent[1].dedupeKey).toMatch(/:reminder$/)
    expect((await loopRow())!.reminded_at).not.toBeNull()
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'awaiting_approval' })
    expect(new Date((await caseRow(l.case_id))!.next_check_at!).getTime()).toBe(asked + ESCALATE_AFTER_MS)
    // a second check before 72 hours does not remind again
    await admin(db => db.query('update cases set next_check_at = $2 where id = $1', [l.case_id, new Date(asked + 30 * 3600e3).toISOString()]))
    await runCaseCheck(l.case_id, new Date(asked + 30 * 3600e3))
    expect(sent).toHaveLength(2)
    await runCaseCheck(l.case_id, new Date(asked + ESCALATE_AFTER_MS + 60e3))
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'escalated' })
    expect(sent.map(s => s.severity)).toEqual(['action', 'action', 'warning'])
    expect((await loopRow())!.escalated_at).not.toBeNull()
    // still in the inbox, and approving from escalated works
    const item = (await listPendingApprovals(owner, { source: 'agent_action' })).items.find(i => i.id === l.id)!
    expect(item.why).toMatch(/3 days/)
    registerLoopResumer('w1-fixer', async () => spec())
    await decideApproval(owner, 'agent_action', l.id, 'approve', { version: item.version })
    await runDueJobs({ kinds: [LOOP_RESUME_JOB] })
    expect((await caseRow(l.case_id))!.status).toBe('resolved')
  })

  it('cannot finish: the case is blocked with the reason, the owner is told once, retries after a backoff, then fails and asks for the owner', async () => {
    world.failAct = 99
    const t0 = Date.now()
    let now = new Date(t0)
    const r1 = await run({ now: () => now })
    expect(r1).toMatchObject({ status: 'failed', error: 'Fixer could not finish: the store refused the change', retryAt: expect.any(String) })
    const l = (await loopRow())!
    expect(l).toMatchObject({ state: 'blocked', attempts: 1 })
    const c = (await caseRow(l.case_id))!
    expect(c.status).toBe('blocked')
    expect(c.status_reason).toMatch(/the store refused the change\. Trying again at/)
    expect(sent.map(s => [s.severity, s.dedupeKey.split(':').pop()])).toEqual([['warning', 'blocked']])
    // re-run before the retry time: same answer, no act, nothing new sent
    expect(await run({ now: () => now })).toMatchObject({ status: 'failed', error: r1.status === 'failed' ? r1.error : '' })
    expect(world.acts).toBe(1)
    expect(sent).toHaveLength(1)
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      now = new Date(now.getTime() + 24 * 3600e3)
      await run({ now: () => now })
    }
    expect(world.acts).toBe(MAX_ATTEMPTS)
    expect((await loopRow())!.state).toBe('failed')
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'failed' })
    expect(sent.at(-1)).toMatchObject({ severity: 'warning', whatIDid: [`I tried ${MAX_ATTEMPTS} times and could not finish. This needs you.`, 'Fixer could not finish: the store refused the change'] })
    // the same problem later is a new loop on the same (failed, still open) case: ONE case per problem
    world.failAct = 0
    expect(await run({ now: () => new Date(now.getTime() + 3600e3) })).toMatchObject({ status: 'done' })
    expect((await loopRow())!.case_id).toBe(l.case_id)
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'resolved' })
  })

  it('a fix that does not hold on the fresh read is not verified: the case is blocked, not resolved', async () => {
    world.verifyLies = true
    const out = await run()
    expect(out).toMatchObject({ status: 'not_verified', proof: [{ label: 'Changed' }, { label: 'Fresh read of listing 42' }] })
    const l = (await loopRow())!
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'blocked' })
    expect(l.undo_token_id).toBeNull()
    // a verify with no proof is not a verification either
    world = fresh()
    expect(await run({ problemKey: 'w1:noproof', verify: async () => ({ ok: true, proof: [] }) })).toMatchObject({ status: 'not_verified' })
  })

  it('two agents on one job: the second sees the case is owned, stops and leaves one note; at once, only one acts', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'update_listing', 'ask_first')
    await run()
    const l = (await loopRow())!
    const other = spec({ agentKey: 'w1-other', agentName: 'Other agent', actionType: 'tag_order' })
    let otherActs = 0
    other.act = async () => { otherActs++; return {} }
    for (let i = 0; i < 2; i++) expect(await admin(db => runAgentLoop(db, other))).toMatchObject({ status: 'nothing_to_do', reason: 'owned_by_other_agent', ownerAgent: 'Fixer' })
    expect(otherActs).toBe(0)
    const notes = (await caseEvents(l.case_id)).filter(e => e.type === 'note')
    expect(notes).toEqual([{ type: 'note', actor: 'agent:w1-other', summary: 'Other agent also found this problem; Fixer is handling it, so Other agent stopped.' }])

    // concurrently, act_and_tell: exactly one of the two acts
    world = fresh(); world.slow = 300
    const a = spec({ problemKey: 'w1:race', actionType: 'tag_order' })
    const b = spec({ problemKey: 'w1:race', actionType: 'tag_order', agentKey: 'w1-racer', agentName: 'Racer' })
    const outs = await Promise.all([admin(db => runAgentLoop(db, a)), admin(db => runAgentLoop(db, b))])
    expect(world.acts).toBe(1)
    expect(outs.map(o => o.status).sort()).toEqual(['done', 'nothing_to_do'])
    expect(await admin(db => db.one<{ n: number }>(`select count(*)::int as n from cases where org_id = $1 and dedupe_key = 'loop:w1:race'`, [NW.org]))).toEqual({ n: 1 })
  })

  it('a problem that disappears while waiting closes its loop and case', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'update_listing', 'ask_first')
    await run()
    const l = (await loopRow())!
    world.broken = false
    expect(await run()).toMatchObject({ status: 'nothing_to_do', reason: 'cleared' })
    expect((await loopRow())!.state).toBe('cleared')
    expect(await caseRow(l.case_id)).toMatchObject({ status: 'cancelled' })
    expect((await listPendingApprovals(owner, { source: 'agent_action' })).items).toHaveLength(0)
  })
})
