import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary } from './helpers'
import { LIBRARY, agentByKey } from '../../lib/library/config'
import { RUNNERS } from '../../lib/library/runners'
import { syntheticStoreData, liveStoreDataStub } from '../../lib/library/store-data'
import { LibraryError } from '../../lib/library/errors'

const ready = await prepareDb()
const NOW = new Date('2026-10-29T12:00:00Z')

describe.skipIf(!ready)('every library agent reads the synthetic store and produces work', () => {
  beforeAll(() => resetLibrary(NW))
  for (const a of LIBRARY.agents) {
    it(`${a.name} produces at least one action, each of a declared type with evidence`, async () => {
      const data = syntheticStoreData(NW.conn, NOW)
      const drafts = await RUNNERS[a.key]({ data, instructions: '', settings: a.key === 'supplier_chaser' ? { supplierAddress: 'orders@supplier.example' } : {}, now: NOW })
      expect(drafts.length, a.key).toBeGreaterThan(0)
      for (const d of drafts) {
        expect(agentByKey(a.key)!.actionTypes.map(t => t.key), `${a.key} produced ${d.actionType}`).toContain(d.actionType)
        expect(d.title.length).toBeGreaterThan(0)
        expect(Object.keys(d.evidence).length).toBeGreaterThan(0)
        expect(d.payload.dedupeKey).toBeTypeOf('string')
      }
    })
  }
  it('Order Tracker flags the stuck orders with the reason and drafts a customer update for each', async () => {
    const drafts = await RUNNERS.order_tracker({ data: syntheticStoreData(NW.conn, NOW), instructions: 'warm tone', settings: {}, now: NOW })
    const flags = drafts.filter(d => d.actionType === 'flag_late_order'), updates = drafts.filter(d => d.actionType === 'draft_customer_update')
    expect(flags.length).toBeGreaterThanOrEqual(3)
    expect(flags.length).toBe(updates.length)
    expect(flags.map(f => String(f.evidence.reason)).join(' ')).toMatch(/not dispatched/)
    expect(flags.map(f => String(f.evidence.reason)).join(' ')).toMatch(/no tracking number/)
    expect(String(updates[0].payload.body)).toMatch(/^Hi /)
    expect(String(updates[0].payload.body)).toMatch(/Warmly,/)
  })
  it('Returns applies the policy: inside the window and unworn approves; worn or late declines; damaged approves', async () => {
    const drafts = await RUNNERS.returns({ data: syntheticStoreData(NW.conn, NOW), instructions: '', settings: {}, now: NOW })
    const byReason = Object.fromEntries(drafts.filter(d => d.actionType === 'draft_return_reply').map(d => [String(d.evidence.reason), String(d.payload.decision)]))
    expect(byReason['Wrong size']).toBe('approve')
    expect(byReason['Changed my mind']).toBe('decline_worn')
    expect(byReason['Arrived damaged']).toBe('approve')
    expect(byReason['Not as described']).toBe('decline_window')
    expect(drafts.filter(d => d.actionType === 'approve_return')).toHaveLength(2)
  })
  it('Listing Writer honours a word limit and tone from the standing instructions and never invents claims', async () => {
    const drafts = await RUNNERS.listing_writer({ data: syntheticStoreData(NW.conn, NOW), instructions: 'warm tone, under 40 words each', settings: {}, now: NOW })
    const descs = drafts.filter(d => d.actionType === 'draft_description')
    expect(descs.length).toBeGreaterThan(0)
    for (const d of descs) { expect(String(d.payload.to).split(/\s+/).length).toBeLessThanOrEqual(41); expect(String(d.payload.to)).not.toMatch(/award|best-selling|guarantee/i) }
    expect(String(descs[0].payload.to)).toMatch(/^Meet the/)
  })
  it('Inventory Watcher skips pre-order and backorder products and drafts the exact setting change', async () => {
    const drafts = await RUNNERS.inventory_watcher({ data: syntheticStoreData(NW.conn, NOW), instructions: '', settings: {}, now: NOW })
    const fixes = drafts.filter(d => d.actionType === 'draft_inventory_policy_fix')
    expect(fixes.length).toBeGreaterThan(0)
    for (const f of fixes) { expect(f.payload).toMatchObject({ field: 'inventoryPolicy', from: 'CONTINUE', to: 'DENY' }); expect((f.evidence.tags as string[]).some(t => /pre-order|backorder/i.test(t))).toBe(false) }
    expect(drafts.some(d => d.actionType === 'flag_oversold' && d.title.includes('Ceramic Pour-Over Set'))).toBe(true)
  })
  it('Payout and Fees Checker reconciles each payout, flags the fee above the rate and the missing payout', async () => {
    const drafts = await RUNNERS.payout_fees_checker({ data: syntheticStoreData(NW.conn, NOW), instructions: 'fees above 2.9% plus 30 cents', settings: {}, now: NOW })
    expect(drafts.filter(d => d.actionType === 'flag_fee_anomaly')).toHaveLength(1)
    expect(drafts.some(d => d.title.includes('has not arrived'))).toBe(true)
  })
  it('AI Visibility reports the Agentic channel gaps per product and recommends a fix for each', async () => {
    const drafts = await RUNNERS.ai_visibility({ data: syntheticStoreData(NW.conn, NOW), instructions: '', settings: {}, now: NOW })
    const checks = drafts.filter(d => d.actionType === 'check_ai_visibility'), fixes = drafts.filter(d => d.actionType === 'recommend_visibility_fix')
    expect(checks.length).toBeGreaterThan(5)
    expect(fixes.length).toBe(checks.filter(c => (c.evidence.gaps as string[]).length > 0).length)
    expect(checks.flatMap(c => c.evidence.gaps as string[]).join(' ')).toMatch(/Agentic/)
  })
  it('Promo Manager proposes a code for slow stock, drafts its creation, and ends the expired code', async () => {
    const drafts = await RUNNERS.promo_manager({ data: syntheticStoreData(NW.conn, NOW), instructions: 'Propose a 15% code for anything with more than 90 days of stock, ending in two weeks.', settings: {}, now: NOW })
    expect(drafts.find(d => d.actionType === 'create_discount')?.payload).toMatchObject({ code: 'MOVE15', percent: 15 })
    expect(drafts.some(d => d.actionType === 'end_discount' && d.title.includes('SPRING10'))).toBe(true)
  })
  it('the live store is a stub: every read and write refuses with not_wired', async () => {
    const live = liveStoreDataStub()
    expect(live.synthetic).toBe(false)
    for (const fn of [live.products, live.orders, live.returns, live.payouts, live.discounts, live.customerMessages, live.sales, live.channels]) await expect(fn()).rejects.toMatchObject({ code: 'not_wired' })
    await expect(live.setProductText('x', 'title', 'y')).rejects.toBeInstanceOf(LibraryError)
    await expect(live.createDiscount({ code: 'X', percent: 1, endsAt: null })).rejects.toMatchObject({ code: 'not_wired' })
  })
})
