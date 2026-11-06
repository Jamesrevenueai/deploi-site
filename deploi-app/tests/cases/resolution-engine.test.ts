import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { admin, withUser } from '../../lib/db'
import { prepareDb, SESSIONS } from '../db/helpers'
import { NW, HB } from '../merchant/helpers'
import {
  openCase, transitionCase, recordAction, resolveCase, handOffCase, addEvidence, getCase, listCases, caseCounts,
  canTransition, registerCaseKind, runCaseCheck, caseForRecord, type OpenCaseInput,
} from '../../lib/cases'
import { enqueueDueCases } from '../../lib/cases/jobs'

const ready = await prepareDb()
const clean = () => admin(async db => { await db.query(`delete from jobs where kind = 'case.check'`); await db.query('delete from cases where org_id = any($1)', [[NW.org, HB.org]]) })
const now = () => new Date().toISOString()
const base = (over: Partial<OpenCaseInput> = {}): OpenCaseInput => ({
  orgId: NW.org, suite: 'commerce', kind: 'test_supplier_delay', sourceApp: 'import', dedupeKey: 'po:1001:confirmation',
  title: 'Supplier has not confirmed PO 1001', problem: 'PO 1001 was sent 4 days ago and has no confirmation.',
  verification: { criteria: 'The supplier confirms quantities and a delivery date for PO 1001' }, actor: 'test',
  evidence: [{ label: 'PO 1001 sent', source: 'import', observedAt: now() }], records: [{ type: 'purchase_order', id: 'po-1001', label: 'PO 1001' }], ...over,
})

describe.skipIf(!ready)('Resolution Engine', () => {
  beforeEach(clean)
  afterAll(clean)

  it('opens one case per problem; detecting it again adds evidence to the open case', async () => {
    const a = await admin(db => openCase(db, base()))
    expect(a.created).toBe(true)
    expect(a.case.ref).toMatch(/^DC-\d{6}$/)
    expect(a.case.status).toBe('detected')
    const b = await admin(db => openCase(db, base({ evidence: [{ label: 'Still unconfirmed', source: 'import', observedAt: now() }] })))
    expect(b.created).toBe(false)
    expect(b.case.id).toBe(a.case.id)
    expect(b.case.evidence).toHaveLength(2)
    const h = (await admin(db => getCase(db, NW.org, a.case.ref)))!
    expect(h.events.map(e => e.type)).toEqual(['opened', 'redetected'])
    expect((await admin(db => caseForRecord(db, NW.org, 'purchase_order', 'po-1001')))!.id).toBe(a.case.id)
  })

  it('refuses a case without verification criteria', async () => {
    await expect(admin(db => openCase(db, base({ verification: { criteria: ' ' } })))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('follows the lifecycle: an action never resolves; resolving needs verification evidence; resolved never reopens', async () => {
    const { case: c } = await admin(db => openCase(db, base()))
    await admin(db => transitionCase(db, c.id, { to: 'proposed', actor: 'agent:x', reason: 'Drafted a confirmation request' }))
    await admin(db => transitionCase(db, c.id, { to: 'awaiting_approval', actor: 'agent:x', reason: 'Waiting for you to approve the email', approvalRequired: true }))
    await admin(db => transitionCase(db, c.id, { to: 'executing', actor: 'user:owner', reason: 'Approved' }))
    await admin(db => recordAction(db, c.id, { actor: 'agent:x', summary: 'Sent the confirmation request', ref: { type: 'email_message', id: 'm-1' } }))
    const waiting = await admin(db => transitionCase(db, c.id, { to: 'waiting_external', actor: 'agent:x', reason: 'Waiting for the supplier', nextCheckAt: new Date(Date.now() + 864e5) }))
    expect(waiting.status).toBe('waiting_external')
    expect(waiting.attempts).toBe(1)
    // the lifecycle refuses shortcuts and a resolution without evidence
    expect(canTransition('waiting_external', 'resolved')).toBe(false)
    await expect(admin(db => transitionCase(db, c.id, { to: 'resolved', actor: 'agent:x', reason: 'sent it' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(admin(db => resolveCase(db, c.id, { actor: 'agent:x', summary: 'done', evidence: [], verifiedBy: 'agent:x' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await admin(db => transitionCase(db, c.id, { to: 'verifying', actor: 'agent:x', reason: 'Supplier replied; checking the PO' }))
    const done = await admin(db => resolveCase(db, c.id, { actor: 'agent:x', summary: 'Supplier confirmed 12 units for 14 Nov', verifiedBy: 'purchase order record',
      evidence: [{ label: 'PO 1001 confirmed: 12 units, delivery 2026-11-14', source: 'import', observedAt: now(), ref: { type: 'purchase_order', id: 'po-1001' } }] }))
    expect(done).toMatchObject({ status: 'resolved', next_check_at: null })
    expect(done.outcome!.verifiedBy).toBe('purchase order record')
    expect(done.closed_at).not.toBeNull()
    await expect(admin(db => transitionCase(db, c.id, { to: 'investigating', actor: 'x', reason: 'reopen' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(admin(db => resolveCase(db, c.id, { actor: 'x', summary: 'again', verifiedBy: 'x', evidence: [{ label: 'x', source: 'x', observedAt: now() }] }))).rejects.toMatchObject({ code: 'not_pending' })
    // the same problem seen again after resolution is a new case
    const again = await admin(db => openCase(db, base()))
    expect(again.created).toBe(true)
    expect(again.case.id).not.toBe(c.id)
    const h = (await admin(db => getCase(db, NW.org, c.id)))!
    expect(h.events.map(e => e.type)).toEqual(['opened', 'status', 'status', 'status', 'action', 'status', 'status', 'verification'])
  })

  it('the database refuses a resolved case without a verified outcome, and edits to history', async () => {
    const { case: c } = await admin(db => openCase(db, base()))
    await expect(admin(db => db.query(`update cases set status = 'resolved' where id = $1`, [c.id]))).rejects.toThrow(/cases_resolved_has_outcome/)
    await expect(admin(db => db.query(`update case_events set summary = 'rewritten' where case_id = $1`, [c.id]))).rejects.toThrow(/append-only/)
  })

  it('a handoff changes ownership within the organization only and grants nothing', async () => {
    const { case: c } = await admin(db => openCase(db, base()))
    const nwAgent = (await admin(db => db.one<{ id: string }>('select id from agents where org_id = $1 limit 1', [NW.org])))!
    // an agent of another organization (or one that does not exist) is refused
    const other = (await admin(db => db.one<{ id: string }>('select id from agents where org_id <> $1 limit 1', [NW.org])))?.id ?? '00000000-0000-4000-8000-00000000dead'
    await expect(admin(db => handOffCase(db, c.id, { kind: 'engine', ref: other }, { actor: 'x', reason: 'wrong org' }))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(admin(db => handOffCase(db, c.id, { kind: 'office', ref: '00000000-0000-4000-8000-00000000dead' }, { actor: 'x', reason: 'missing' }))).rejects.toMatchObject({ code: 'forbidden' })
    const policiesBefore = await admin(db => db.query('select id, status, policy from agent_policies where agent_id = $1 order by id', [nwAgent.id]))
    await admin(db => handOffCase(db, c.id, { kind: 'engine', ref: nwAgent.id }, { actor: 'agent:coordinator', reason: 'Supplier work goes to the Supplier Coordinator' }))
    const h = (await admin(db => getCase(db, NW.org, c.id)))!
    expect(h.case).toMatchObject({ agent_kind: 'engine', agent_ref: nwAgent.id })
    expect(h.events.at(-1)!.detail.grants).toMatch(/none/)
    expect(await admin(db => db.query('select id, status, policy from agent_policies where agent_id = $1 order by id', [nwAgent.id]))).toEqual(policiesBefore)
  })

  it('organizations see only their own cases and history (RLS)', async () => {
    const { case: c } = await admin(db => openCase(db, base()))
    await admin(db => addEvidence(db, c.id, { label: 'note', source: 'import', observedAt: now() }, 'test'))
    const hb = await withUser(SESSIONS.harbor, async db => ({ cases: await db.query('select id from cases'), events: await db.query('select id from case_events'), links: await db.query('select case_id from case_links') }))
    expect(hb.cases.find(r => (r as { id: string }).id === c.id)).toBeUndefined()
    expect(hb.events).toHaveLength(0)
    expect(hb.links).toHaveLength(0)
    expect(await withUser(SESSIONS.harbor, db => getCase(db, NW.org, c.id))).toBeNull()
    const nw = await withUser(SESSIONS.northwind, db => getCase(db, NW.org, c.ref))
    expect(nw!.events.length).toBeGreaterThan(1)
    await expect(withUser(SESSIONS.northwind, db => db.query(`update cases set title = 'x' where id = $1`, [c.id]))).rejects.toThrow(/permission denied/)
  })

  it('lists by view and counts', async () => {
    const a = (await admin(db => openCase(db, base({ dedupeKey: 'k:a' })))).case
    const b = (await admin(db => openCase(db, base({ dedupeKey: 'k:b' })))).case
    await admin(db => transitionCase(db, b.id, { to: 'awaiting_approval', actor: 'x', reason: 'needs you' }))
    expect((await admin(db => listCases(db, NW.org, { view: 'needs_approval' }))).map(r => r.id)).toEqual([b.id])
    expect((await admin(db => listCases(db, NW.org, { view: 'in_progress' }))).map(r => r.id)).toEqual([a.id])
    expect(await admin(db => caseCounts(db, NW.org))).toMatchObject({ in_progress: 1, needs_approval: 1, completed: 0, total: 2 })
  })

  it('due cases are checked durably by their kind; a checker that does nothing does not leave the case due', async () => {
    const seen: string[] = []
    registerCaseKind('test_supplier_delay', async c => {
      seen.push(c.id)
      await admin(db => resolveCase(db, c.id, { actor: 'checker', summary: 'Confirmed on re-read', verifiedBy: 'test source', evidence: [{ label: 'confirmed', source: 'import', observedAt: now() }] }))
    })
    registerCaseKind('test_noop', async () => {})
    const due = (await admin(db => openCase(db, base({ nextCheckAt: new Date(Date.now() - 1000) })))).case
    const noop = (await admin(db => openCase(db, base({ kind: 'test_noop', dedupeKey: 'k:noop', nextCheckAt: new Date(Date.now() - 1000) })))).case
    const r1 = await enqueueDueCases()
    expect(r1.filter(r => r.created)).toHaveLength(2)
    expect((await enqueueDueCases()).filter(r => r.created)).toHaveLength(0) // idempotent per case and due time
    expect(await runCaseCheck(due.id)).toEqual({ status: 'resolved' })
    expect(seen).toEqual([due.id])
    await runCaseCheck(noop.id)
    const n = (await admin(db => db.one<{ next_check_at: string }>('select next_check_at from cases where id = $1', [noop.id])))!
    expect(new Date(n.next_check_at).getTime()).toBeGreaterThan(Date.now())
    expect(await runCaseCheck(due.id)).toMatchObject({ status: 'skipped' })
  })
})
