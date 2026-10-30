import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary, actionsOf } from './helpers'
import { merchantActor } from '../merchant/helpers'
import { setSwitch, setPermission, grantAutoRun, revokeAutoRun, teamView } from '../../lib/library/switches'
import { runLibraryAgent, approveAction, declineAction, activityLog, APPROVAL_ONLY } from '../../lib/library/actions'
import { syntheticStoreData } from '../../lib/library/store-data'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const NOW = new Date('2026-10-29T12:00:00Z')

describe.skipIf(!ready)('permission levels: read, draft for approval, act within limits', () => {
  beforeEach(async () => { await resetLibrary(NW, 'pro'); await setSwitch(await merchantActor(NW), 'listing_writer', true) })

  it('read: reports only; nothing that writes is even drafted', async () => {
    const actor = await merchantActor(NW)
    await setPermission(actor, 'listing_writer', 'read')
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect(r.status).toBe('completed')
    expect(r.counts.drafted).toBe(0)
    expect(r.counts.done).toBe(0)
    expect(r.counts.skipped).toBeGreaterThan(0)
    expect(await actionsOf(NW, 'listing_writer')).toEqual([])
    // a reporting agent at read still reports
    await setSwitch(actor, 'ai_visibility', true); await setPermission(actor, 'ai_visibility', 'read')
    const v = await runLibraryAgent({ orgId: NW.org, agentKey: 'ai_visibility', trigger: 'test', actor: actor.label, now: NOW })
    expect(v.counts.noted).toBeGreaterThan(0)
    expect((await actionsOf(NW, 'ai_visibility')).every(a => a.status === 'noted' && a.mode === 'read')).toBe(true)
  })

  it('draft (the default): every change waits in the approval queue; nothing in the store changes', async () => {
    const actor = await merchantActor(NW)
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.permission).toBe('draft')
    const before = await syntheticStoreData(NW.conn, NOW).products()
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect(r.counts.drafted).toBeGreaterThan(0)
    expect(r.counts.done).toBe(0)
    const rows = await actionsOf(NW, 'listing_writer')
    expect(rows.every(a => a.status === 'draft' && a.permission_basis === 'draft: every change waits for your approval')).toBe(true)
    expect(await syntheticStoreData(NW.conn, NOW).products()).toEqual(before)
    // running again does not duplicate open drafts
    const again = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect(again.counts.drafted).toBe(0)
    expect(again.counts.skipped).toBe(r.counts.drafted)
  })

  it('act without a grant behaves like draft; act with a grant runs the granted type only, with proof from a fresh read', async () => {
    const actor = await merchantActor(NW)
    await setPermission(actor, 'listing_writer', 'act')
    const r0 = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect(r0.counts.done).toBe(0)
    expect(r0.counts.drafted).toBeGreaterThan(0)
    expect((await actionsOf(NW, 'listing_writer'))[0].permission_basis).toMatch(/no auto-run grant/)
    await admin(db => db.query(`delete from library_actions where org_id = $1`, [NW.org]))
    expect(await grantAutoRun(actor, 'listing_writer', 'draft_description', 3)).toEqual({ actionType: 'draft_description', maxPerDay: 3 })
    const r1 = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const rows = await actionsOf(NW, 'listing_writer')
    const auto = rows.filter(a => a.mode === 'auto')
    expect(auto.length).toBe(3) // the daily cap
    expect(auto.every(a => a.action_type === 'draft_description' && a.status === 'done')).toBe(true)
    for (const a of auto) { expect(a.proof).toMatchObject({ verifiedBy: 'fresh read after the write', synthetic: true }); expect(a.proof!.after).toBe(a.payload.to) }
    expect(rows.filter(a => a.action_type === 'draft_title').every(a => a.status === 'draft')).toBe(true)
    expect(rows.filter(a => a.action_type === 'draft_description' && a.status === 'draft').every(a => /cap of 3 a day/.test(a.permission_basis ?? ''))).toBe(true)
    expect(r1.counts.done).toBe(3)
    // the store really changed
    const products = await syntheticStoreData(NW.conn, NOW).products()
    for (const a of auto) expect(products.find(p => p.id === a.payload.productId)!.description).toBe(a.payload.to)
    // revoking stops it at once
    expect(await revokeAutoRun(actor, 'listing_writer', 'draft_description')).toEqual({ revoked: 1 })
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.grants).toEqual([])
  })

  it('lowering the level below act revokes every grant', async () => {
    const actor = await merchantActor(NW)
    await setPermission(actor, 'listing_writer', 'act')
    await grantAutoRun(actor, 'listing_writer', 'draft_title')
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.grants).toHaveLength(1)
    await setPermission(actor, 'listing_writer', 'draft')
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.grants).toHaveLength(0)
  })

  it('money and publishing actions are approval-only at every level: no grant, no auto-run, even at act', async () => {
    const actor = await merchantActor(NW)
    for (const [agent, type] of [['returns', 'approve_return'], ['promo_manager', 'create_discount'], ['promo_manager', 'end_discount'], ['customer_care', 'send_customer_reply']] as const) {
      await setSwitch(actor, agent, true)
      await setPermission(actor, agent, 'act')
      await expect(grantAutoRun(actor, agent, type)).rejects.toMatchObject({ code: 'forbidden' })
      expect(APPROVAL_ONLY.has(type)).toBe(true)
    }
    await admin(db => db.query(`insert into library_auto_run_grants (org_id, agent_key, action_type, granted_by) values ($1,'returns','approve_return','test')`, [NW.org]))
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'returns', trigger: 'test', actor: actor.label, now: NOW })
    expect(r.counts.done).toBe(0)
    const approvals = (await actionsOf(NW, 'returns')).filter(a => a.action_type === 'approve_return')
    expect(approvals.length).toBeGreaterThan(0)
    expect(approvals.every(a => a.status === 'draft' && /moves money or publishes/.test(a.permission_basis ?? ''))).toBe(true)
  })

  it('a reporting action type needs no grant', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'order_tracker', true); await setPermission(actor, 'order_tracker', 'act')
    await expect(grantAutoRun(actor, 'order_tracker', 'flag_late_order')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(grantAutoRun(actor, 'order_tracker', 'nope')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('approving a draft makes the change and keeps the proof; declining records the reason; both appear in the log', async () => {
    const actor = await merchantActor(NW)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const rows = await actionsOf(NW, 'listing_writer')
    const title = rows.find(a => a.action_type === 'draft_title')!, desc = rows.find(a => a.action_type === 'draft_description')!
    const ok = await approveAction(actor, title.id, NOW)
    expect(ok).toMatchObject({ status: 'done', executed: true })
    expect(ok.proof).toMatchObject({ before: title.payload.from, after: title.payload.to, approvedBy: actor.label })
    expect((await syntheticStoreData(NW.conn, NOW).products()).find(p => p.id === title.payload.productId)!.title).toBe(title.payload.to)
    await declineAction(actor, desc.id, 'not now', NOW)
    const after = await actionsOf(NW, 'listing_writer')
    expect(after.find(a => a.id === title.id)!.status).toBe('done')
    expect(after.find(a => a.id === desc.id)).toMatchObject({ status: 'declined', status_reason: 'not now' })
    await expect(approveAction(actor, desc.id, NOW)).rejects.toMatchObject({ code: 'conflict' })
    const log = await activityLog(actor, NW.org, 'listing_writer')
    expect(log.some(e => e.kind === 'action' && e.status === 'Done, verified by a fresh read')).toBe(true)
    expect(log.some(e => e.kind === 'run')).toBe(true)
  })

  it('approving an email draft marks it approved but sends nothing: email is off', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'order_tracker', true)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'order_tracker', trigger: 'test', actor: actor.label, now: NOW })
    const u = (await actionsOf(NW, 'order_tracker')).find(a => a.action_type === 'draft_customer_update')!
    const r = await approveAction(actor, u.id, NOW)
    expect(r).toEqual({ status: 'approved', executed: false })
    const row = (await actionsOf(NW, 'order_tracker')).find(a => a.id === u.id)!
    expect(row.status).toBe('approved')
    expect(row.status_reason).toMatch(/nothing was sent/)
    expect(row.proof).toMatchObject({ sent: false })
  })

  it('a switched-off agent does not run; switching off expires its open drafts', async () => {
    const actor = await merchantActor(NW)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    await setSwitch(actor, 'listing_writer', false)
    expect((await actionsOf(NW, 'listing_writer')).every(a => a.status === 'expired')).toBe(true)
    await expect(runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('a real (non-synthetic) store is blocked: live reads are a stub in this build, and nothing is written', async () => {
    const actor = await merchantActor(NW)
    await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
    try {
      const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
      expect(r.status).toBe('blocked')
      expect(r.reason).toMatch(/not wired/)
      expect(await actionsOf(NW, 'listing_writer')).toEqual([])
    } finally { await admin(db => db.query('update store_connections set is_synthetic = true where id = $1', [NW.conn])) }
  })
})
