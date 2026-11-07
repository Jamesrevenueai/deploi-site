/** Undo tokens: single use, owner/admin of that organization only, expiry, retry after a failure, generic kinds. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { createUndo, registerUndo, hashUndoToken, undoPath } from '../../lib/undo'
import { runUndo, previewUndo } from '../../lib/undo/run'
import { openCase } from '../../lib/cases'
import { mutateSynthetic } from '../../lib/connectors/shopify/synthetic'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { NW, HB, merchantActor, resetMerchant, staffActor, store } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { cleanW1 } from './helpers'

const ready = await prepareDb()
const { P } = NORTHWIND_IDS as unknown as { P: (n: number) => string }
const calls: Record<string, unknown>[] = []
let throwOnce = false
registerUndo('w1.undo.test', async (_db, p) => { if (throwOnce) { throwOnce = false; throw new Error('provider unavailable') } calls.push(p); return { ok: true, detail: 'Put the price back to 19.00' } })

async function aCase() {
  return admin(async db => (await openCase(db, { orgId: NW.org, suite: 'commerce', kind: 'agent_action', sourceApp: 'agent', dedupeKey: `w1-undo:${Math.random()}`, title: 'Changed a price', problem: 'test', verification: { criteria: 'read' }, actor: 'test' })).case)
}

describe.skipIf(!ready)('undo tokens', () => {
  beforeEach(async () => { await cleanW1(); calls.length = 0; throwOnce = false })
  afterAll(async () => { await cleanW1(); await removePeople(NW); await resetMerchant(NW) })

  it('the owner undoes once: the reversal runs with the token\'s organization, the result is on the case, the link then reads as used', async () => {
    const c = await aCase()
    const { token } = await createUndo({ orgId: NW.org, kind: 'w1.undo.test', payload: { listing: 42, orgId: HB.org }, summary: 'Undo: price change on listing 42', caseId: c.id, agentKey: 'w1-fixer' })
    expect(undoPath(token)).toBe(`/undo/${token}`)
    const owner = await merchantActor(NW)
    expect(await previewUndo(owner, token)).toMatchObject({ state: 'ready', summary: 'Undo: price change on listing 42', caseRef: c.ref })
    expect(await runUndo(owner, token)).toEqual({ ok: true, detail: 'Put the price back to 19.00', caseRef: c.ref })
    expect(calls).toEqual([{ listing: 42, orgId: NW.org }]) // a payload never names another organization
    await expect(runUndo(owner, token)).rejects.toMatchObject({ code: 'not_pending' })
    expect(calls).toHaveLength(1)
    expect(await previewUndo(owner, token)).toMatchObject({ state: 'used', result: { ok: true } })
    const note = await admin(db => db.one<{ summary: string }>(`select summary from case_events where case_id = $1 and type = 'note' order by id desc limit 1`, [c.id]))
    expect(note!.summary).toBe(`Undone by ${owner.label}: Put the price back to 19.00`)
    expect(await admin(db => db.one(`select 1 from engine_audit where org_id = $1 and event = 'undo.done' and entity_id = $2`, [NW.org, c.id]))).toBeTruthy()
  })

  it('another organization, members, viewers and staff cannot use it; an expired link does nothing', async () => {
    const { token } = await createUndo({ orgId: NW.org, kind: 'w1.undo.test', payload: {}, summary: 'Undo: x' })
    const hb = await merchantActor(HB)
    expect(await previewUndo(hb, token)).toMatchObject({ state: 'not_found', summary: null })
    await expect(runUndo(hb, token)).rejects.toMatchObject({ code: 'not_found' })
    await expect(runUndo(await person(NW, 'member', 'w1-undo-member'), token)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(runUndo(await person(NW, 'viewer', 'w1-undo-viewer'), token)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(runUndo(await staffActor(), token)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(runUndo(await merchantActor(NW), 'u_not-a-real-token-at-all-000')).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toHaveLength(0)
    // an admin may
    expect(await runUndo(await person(NW, 'admin', 'w1-undo-admin'), token)).toMatchObject({ ok: true })
    const old = await createUndo({ orgId: NW.org, kind: 'w1.undo.test', payload: {}, summary: 'Undo: y', now: new Date(Date.now() - 8 * 86400e3) })
    expect(await previewUndo(await merchantActor(NW), old.token)).toMatchObject({ state: 'expired' })
    await expect(runUndo(await merchantActor(NW), old.token)).rejects.toMatchObject({ code: 'expired' })
    expect(calls).toHaveLength(1)
  })

  it('a reversal that fails part way gives the link back so the owner can try again', async () => {
    const { token } = await createUndo({ orgId: NW.org, kind: 'w1.undo.test', payload: {}, summary: 'Undo: z' })
    throwOnce = true
    const owner = await merchantActor(NW)
    await expect(runUndo(owner, token)).rejects.toMatchObject({ code: 'not_retryable' })
    expect(await previewUndo(owner, token)).toMatchObject({ state: 'ready' })
    expect(await runUndo(owner, token)).toMatchObject({ ok: true })
  })

  it('only the hash is stored, and user roles cannot read it', async () => {
    const { token, id } = await createUndo({ orgId: NW.org, kind: 'w1.undo.test', payload: {}, summary: 'Undo: h' })
    const row = await admin(db => db.one<Record<string, unknown>>('select * from undo_tokens where id = $1', [id]))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row!.token_hash).toBe(hashUndoToken(token))
    await expect(withUser(SESSIONS.northwind, db => db.query('select token_hash from undo_tokens'))).rejects.toThrow(/permission denied/)
    expect(await withUser(SESSIONS.northwind, db => db.query('select id, summary from undo_tokens where id = $1', [id]))).toHaveLength(1)
    expect(await withUser(SESSIONS.harbor, db => db.query('select id from undo_tokens where id = $1', [id]))).toHaveLength(0)
  })

  it('synthetic.product.restore puts a synthetic product back, and refuses another organization\'s store', async () => {
    await resetMerchant(NW)
    await mutateSynthetic(NW.conn, s => { const p = s.products.find(x => x.id === P(1001))!; p.tags = ['home', 'clearance'] })
    const owner = await merchantActor(NW)
    const { token } = await createUndo({ orgId: NW.org, kind: 'synthetic.product.restore', payload: { connectionId: NW.conn, productId: P(1001), before: { tags: ['home'] } }, summary: 'Undo: tagged clearance' })
    expect(await runUndo(owner, token)).toMatchObject({ ok: true, detail: expect.stringMatching(/tags home/) })
    expect((await store(NW))!.products.find(x => x.id === P(1001))!.tags).toEqual(['home'])
    // a token of Harbor naming Northwind's store does nothing
    const hb = await createUndo({ orgId: HB.org, kind: 'synthetic.product.restore', payload: { connectionId: NW.conn, productId: P(1001), before: { tags: [] } }, summary: 'Undo: cross-org' })
    expect(await runUndo(await merchantActor(HB), hb.token)).toEqual({ ok: false, detail: 'the store was not found', caseRef: null })
    expect((await store(NW))!.products.find(x => x.id === P(1001))!.tags).toEqual(['home'])
  })
})
