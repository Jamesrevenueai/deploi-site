import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { NW, HB, merchantActor, resetMerchant, store } from '../merchant/helpers'
import { listPendingApprovals, decideApproval } from '../../lib/approvals'
import { openSyntheticCase, DEMO_CASE_KIND, DEMO_TAG } from '../../lib/cases/demo'
import { getCase } from '../../lib/cases'

const ready = await prepareDb()
const clean = () => admin(db => db.query('delete from cases where org_id = any($1)', [[NW.org, HB.org]]))

describe.skipIf(!ready)('case decisions (the synthetic demo case)', () => {
  beforeEach(async () => { await clean(); await resetMerchant(NW) })
  afterAll(async () => { await clean(); await resetMerchant(NW) })

  it('waits in the unified inbox with its exact content; approving changes the synthetic store and resolves only with a fresh read', async () => {
    const c = await openSyntheticCase(NW.conn, NW.org, 'test')
    expect(c.status).toBe('awaiting_approval')
    const p = (await store(NW))!.products.find(x => x.id === c.records[0].id)!
    expect(p.tags).toContain(DEMO_TAG)
    const actor = await merchantActor(NW)
    const { items } = await listPendingApprovals(actor)
    const it = items.find(i => i.source === 'case' && i.id === c.id)!
    expect(it).toMatchObject({ kind: `case_${DEMO_CASE_KIND}`, decisions: ['approve', 'reject'] })
    expect(it.content).toMatchObject({ case: c.ref, nextAction: c.next_action })
    // another organization does not see it and cannot decide it
    const hb = await merchantActor(HB)
    expect((await listPendingApprovals(hb)).items.find(i => i.id === c.id)).toBeUndefined()
    await expect(decideApproval(hb, 'case', c.id, 'approve', { version: it.version })).rejects.toMatchObject({ code: 'not_found' })
    // a stale version is refused
    await expect(decideApproval(actor, 'case', c.id, 'approve', { version: '0'.repeat(64) })).rejects.toMatchObject({ code: 'hash_mismatch' })
    const r = await decideApproval(actor, 'case', c.id, 'approve', { version: it.version })
    expect(r.status).toBe('resolved')
    const after = (await admin(db => getCase(db, NW.org, c.ref)))!
    expect(after.case.status).toBe('resolved')
    expect(after.case.outcome!.verifiedBy).toMatch(/Fresh read/)
    expect(after.events.map(e => e.type)).toEqual(['opened', 'status', 'status', 'action', 'status', 'verification'])
    expect((await store(NW))!.products.find(x => x.id === p.id)!.tags).not.toContain(DEMO_TAG)
    // decided once: it is gone from the inbox and a second decision is refused
    expect((await listPendingApprovals(actor)).items.find(i => i.id === c.id)).toBeUndefined()
    await expect(decideApproval(actor, 'case', c.id, 'approve', { version: it.version })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejecting cancels the case and changes nothing', async () => {
    const c = await openSyntheticCase(NW.conn, NW.org, 'test')
    const actor = await merchantActor(NW)
    const it = (await listPendingApprovals(actor)).items.find(i => i.id === c.id)!
    expect((await decideApproval(actor, 'case', c.id, 'reject', { version: it.version })).status).toBe('cancelled')
    expect((await admin(db => getCase(db, NW.org, c.ref)))!.case.status).toBe('cancelled')
    expect((await store(NW))!.products.find(x => x.id === c.records[0].id)!.tags).toContain(DEMO_TAG)
  })

  it('opens only on a synthetic store of the same organization', async () => {
    await expect(openSyntheticCase(NW.conn, HB.org, 'test')).rejects.toMatchObject({ code: 'not_found' })
    await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
    await expect(openSyntheticCase(NW.conn, NW.org, 'test')).rejects.toMatchObject({ code: 'forbidden' })
  })
})
