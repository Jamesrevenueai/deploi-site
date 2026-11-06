import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prepareDb } from '../db/helpers'

const modes = vi.hoisted(() => new Map<string, 'act_and_tell' | 'ask_first'>())
vi.mock('../../lib/autonomy', async orig => ({ ...(await orig<typeof import('../../lib/autonomy')>()), modeFor: async (_db: unknown, _org: string, t: string) => modes.get(t) ?? 'act_and_tell' }))

import { NW, HB, resetCommerce, commerce, productOf, event, deliver, work, owner, crewSent, crewJob, packerId, injectFault, latencies, recordLatency } from './pack-helpers'
import { admin } from '../../lib/db'
import { COMMERCE_IDS } from '../../lib/connectors/shopify/synthetic'
import { runCommerceAgent, decideCommerceWork, undoCommerceWork, COMMERCE_AGENTS } from '../../lib/commerce/pack'
import { sweepCommerce, COMMERCE_TOPICS } from '../../lib/commerce/pack'
import { handlersFor } from '../../lib/events'
import { PACK_AGENTS, agentsFor } from '../../lib/packs/registry'
import { MONEY_ACTIONS } from '../../lib/autonomy'

const ready = await prepareDb()
const sweep = () => deliver(event(NW, 'sweep'))
const done = (rows: { status: string }[]) => rows.filter(r => r.status === 'done')

describe.skipIf(!ready)('commerce pack: registration', () => {
  it('registers all twelve agents with honest status, and every trigger (each Shopify topic and the sweep) with the router', () => {
    const pack = PACK_AGENTS.filter(a => a.pack === 'commerce')
    expect(pack.map(a => a.key).sort()).toEqual(COMMERCE_AGENTS.map(a => a.key).sort())
    expect(pack).toHaveLength(12)
    for (const a of pack) { expect(a.status).toBe('synthetic_only'); expect(a.shopifyReady).toBe(false); expect(a.triggers).toContain('sweep') }
    expect(agentsFor('shopify').filter(a => a.pack === 'commerce')).toHaveLength(0)
    for (const a of COMMERCE_AGENTS) for (const t of a.triggers) expect(handlersFor(t).map(h => h.agentKey), `${a.key} on ${t}`).toContain(a.key)
    for (const t of ['orders/create', 'orders/updated', 'orders/fulfilled', 'fulfillments/create', 'inventory_levels/update', 'products/update', 'customers/update', 'refunds/create', 'returns/request', 'discounts/update']) {
      expect(COMMERCE_TOPICS as readonly string[]).toContain(t)
      expect(handlersFor(t).length, t).toBeGreaterThan(0)
    }
    expect(handlersFor('sweep').map(h => h.agentKey).sort()).toEqual(COMMERCE_AGENTS.map(a => a.key).sort())
    // money actions are the autonomy module's own list
    for (const t of ['refund', 'discount', 'payout_dispute']) expect(MONEY_ACTIONS as readonly string[]).toContain(t)
  })
})

describe.skipIf(!ready)('commerce pack: every scenario is found and handled with no prompting', () => {
  beforeEach(() => { modes.clear() })
  afterAll(() => { console.log('detection latency (event -> problem confirmed, ms):', JSON.stringify(latencies)) })

  it('a quiet store: the sweep finds nothing to fix and sends only the weekly reports, once a week', async () => {
    await resetCommerce(NW)
    await sweep()
    const rows = await work(NW)
    expect(rows.map(r => r.agent_key).sort()).toEqual(['store_health_checker', 'weekly_insights'])
    expect(rows.find(r => r.agent_key === 'store_health_checker')!.title).toBe('Store health: all clear')
    expect(rows.find(r => r.agent_key === 'weekly_insights')!.title).toMatch(/^Your week: \d+ orders, \$/)
    expect(owner.map(u => u.agentKey).sort()).toEqual(['store_health_checker', 'weekly_insights'])
    expect((await commerce(NW)).outbox).toHaveLength(0)
    await sweep()
    expect(await work(NW)).toHaveLength(2)
  })

  it('low stock on a best seller: Inventory Watcher sees it on the stock webhook and Supplier Chaser asks the supplier to restock', async () => {
    await resetCommerce(NW, ['best_seller_low_stock'])
    await deliver(event(NW, 'inventory_levels/update', { inventory_item_id: 5001, available: 3 }))
    const rows = await work(NW, 'best_seller_low_stock')
    expect(done(rows)).toHaveLength(1)
    expect(rows[0].agent_key).toBe('inventory_watcher')
    expect(rows[0].evidence).toMatchObject({ available: 3, rank: 1, supplier: 'orders@highland-mills.example' })
    const mail = (await commerce(NW)).outbox
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({ to: 'orders@highland-mills.example', agentKey: 'supplier_chaser' })
    expect(mail[0].text).toMatch(/Wool Throw Blanket, SKU FH-BLA-4001: \d+ units/)
    expect(mail[0].text).toMatch(/We have 3 left/)
    const u = owner.find(x => x.agentKey === 'inventory_watcher')!
    expect(u.headline).toMatch(/Wool Throw Blanket is running low; Supplier Chaser asked Highland Mills for \d+ more/)
    expect(u.severity).toBe('info')
    expect(u.proof.map(p => p.label)).toContain('Fresh read of sent mail')
    expect(recordLatency('best_seller_low_stock', rows)[0]).toBeLessThan(5000)
    // the same stock event again: handled already this week, no second email
    await deliver(event(NW, 'inventory_levels/update', { inventory_item_id: 5001, available: 3 }))
    expect((await commerce(NW)).outbox).toHaveLength(1)
  })

  it('a best seller with no supplier on file: nothing is sent and the owner is asked who supplies it', async () => {
    await resetCommerce(NW, ['best_seller_low_stock'])
    await admin(db => db.query(`insert into library_switches (org_id, agent_key, enabled, settings) values ($1, 'inventory_watcher', true, '{}') on conflict (org_id, agent_key) do update set enabled = true`, [NW.org]))
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    await mutateSynthetic(NW.conn, s => { s.commerce!.suppliers = [] })
    await runCommerceAgent('inventory_watcher', event(NW, 'sweep'))
    const rows = await work(NW, 'best_seller_low_stock')
    expect(rows[0].status).toBe('draft')
    expect(rows[0].payload.question).toBe('Who supplies Wool Throw Blanket?')
    expect((await commerce(NW)).outbox).toHaveLength(0)
  })

  it('a product selling past zero: Inventory Watcher stops it selling, verifies, and undo puts it back', async () => {
    await resetCommerce(NW, ['selling_past_zero'])
    await sweep()
    const [row] = await work(NW, 'selling_past_zero')
    expect(row.status).toBe('done')
    expect((await productOf(NW, COMMERCE_IDS.basket.product)).variants[0].inventoryPolicy).toBe('DENY')
    expect(row.proof!.items.map(p => `${p.label}: ${p.value}`)).toContain('Fresh read: inventory policy: DENY')
    expect(row.payload.undo).toMatchObject({ kind: 'commerce.restore_inventory_policy' })
    recordLatency('selling_past_zero', [row])
    expect(await undoCommerceWork(NW.org, row.id, 'test')).toMatchObject({ ok: true })
    expect((await productOf(NW, COMMERCE_IDS.basket.product)).variants[0].inventoryPolicy).toBe('CONTINUE')
    // the owner's undo stands: the next sweep does not redo it
    await sweep()
    expect((await productOf(NW, COMMERCE_IDS.basket.product)).variants[0].inventoryPolicy).toBe('CONTINUE')
    expect(await undoCommerceWork(NW.org, row.id, 'test')).toMatchObject({ ok: false, detail: 'already undone' })
  })

  it('a supplier who has not replied in three days: Supplier Chaser follows up once, quoting the request', async () => {
    await resetCommerce(NW, ['restock_no_reply'])
    await sweep()
    await sweep()
    const sent = (await commerce(NW)).outbox.filter(m => m.inReplyTo === 'sent-restock-1')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'trade@clayandkiln.example', subject: 'Following up: Restock request: Stoneware Mug' })
    expect(sent[0].text).toMatch(/> Could you confirm availability/)
    recordLatency('restock_no_reply', await work(NW, 'restock_no_reply'))
  })

  it('a supplier reply: Supplier Chaser reads the ship date and tells the owner, sends nothing', async () => {
    await resetCommerce(NW, ['restock_no_reply'])
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    await mutateSynthetic(NW.conn, s => { s.commerce!.mailbox.push({ id: 'mail-sup-1', receivedAt: new Date().toISOString(), from: 'trade@clayandkiln.example', to: 'hello@fernhill.example', subject: 'Re: Restock request: Stoneware Mug', text: 'We can ship on 2026-11-20.', inReplyTo: 'sent-restock-1' }) })
    await deliver(event(NW, 'mail.received', { id: 'mail-sup-1', from: 'trade@clayandkiln.example' }))
    const [row] = await work(NW, 'supplier_replied')
    expect(row.title).toBe('trade@clayandkiln.example replied: 2026-11-20')
    expect((await commerce(NW)).outbox.filter(m => m.inReplyTo === 'sent-restock-1')).toHaveLength(0)
    // the supplier's mail is not mistaken for a customer question
    expect(await work(NW, 'customer_message_for_owner')).toHaveLength(0)
  })

  it('an order stuck unfulfilled: Order Tracker emails the customer and messages the packer, then verifies', async () => {
    await resetCommerce(NW, ['stuck_order'])
    await sweep()
    const [row] = await work(NW, 'stuck_order')
    expect(row).toMatchObject({ agent_key: 'order_tracker', status: 'done' })
    const mail = (await commerce(NW)).outbox.find(m => m.to === 'kit@shopper.example')!
    expect(mail.subject).toBe('Your order #1201: an update')
    expect(mail.text).toMatch(/^Hi Kit,/)
    expect(mail.text).toMatch(/dispatch within 2 days/)
    // the packer is on the crew roster (crew_members) and is reached through the real crew pipeline
    const sent = await crewSent(NW)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ crew_member_id: packerId, job_refs: ['#1201'], status: 'held' })
    expect((await crewJob(NW, '#1201'))!.details).toMatch(/1 x Brass Lantern/)
    const u = owner.find(x => x.agentKey === 'order_tracker')!
    expect(u.headline).toMatch(/#1201 is 5 days old and not shipped; I told Kit and the packer/)
    expect(u.whatIDid.join(' ')).toMatch(/Asked Sam \(packing\) to pack it today/)
    recordLatency('stuck_order', [row])
    await sweep()
    expect(await crewSent(NW)).toHaveLength(1)
  })

  it('tracking that stopped moving: Order Tracker sends the customer the tracking and a promise to check', async () => {
    await resetCommerce(NW, ['tracking_stalled'])
    await deliver(event(NW, 'fulfillments/update', { order_id: 7202 }))
    const [row] = await work(NW, 'tracking_stalled')
    expect(row.status).toBe('done')
    const mail = (await commerce(NW)).outbox.find(m => m.to === 'lena@shopper.example')!
    expect(mail.text).toMatch(/tracking number FH7202/)
    expect(mail.text).toMatch(/"In transit"/)
    recordLatency('tracking_stalled', [row])
  })

  it('a return inside the policy: Returns approves it on the webhook, emails the customer, no refund until it is back', async () => {
    await resetCommerce(NW, ['return_in_policy'])
    await deliver(event(NW, 'returns/request', { admin_graphql_api_id: 'gid://shopify/Return/8201' }))
    const [row] = await work(NW, 'return_in_policy')
    expect(row).toMatchObject({ status: 'done', mode: 'auto' })
    expect(row.payload.actionType).toBe('refund')
    const c = await commerce(NW)
    expect(c.returns[0].status).toBe('OPEN')
    expect(c.refunds).toHaveLength(0)
    expect(c.outbox[0].text).toMatch(/Your refund of \$24\.00 is issued as soon as the item is back/)
    expect(row.proof!.items.map(p => p.label)).toContain('Fresh read: return status')
    recordLatency('return_in_policy', [row])
  })

  it('a damaged item: Returns approves and refunds at once (a money action), verified against the order refunds', async () => {
    await resetCommerce(NW, ['return_damaged'])
    await deliver(event(NW, 'returns/request', { admin_graphql_api_id: 'gid://shopify/Return/8202' }))
    const [row] = await work(NW, 'return_damaged')
    expect(row.status).toBe('done')
    const c = await commerce(NW)
    expect(c.refunds).toHaveLength(1)
    expect(c.refunds[0]).toMatchObject({ orderId: 'gid://shopify/Order/7204', amount: '24.00' })
    expect(owner.find(x => x.agentKey === 'returns')!.headline).toBe('Return on #1204 approved and $24.00 refunded')
    recordLatency('return_damaged', [row])
  })

  it('a return outside the policy: the customer gets a holding reply; the owner decides, and decline sends the policy reply', async () => {
    await resetCommerce(NW, ['return_outside_policy'])
    await sweep()
    const [row] = await work(NW, 'return_outside_policy')
    expect(row.status).toBe('draft')
    expect(row.payload.options).toEqual(['approve', 'decline'])
    expect(row.summary).toMatch(/45 days after delivery; your window is 30 days/)
    let c = await commerce(NW)
    expect(c.returns[0].status).toBe('REQUESTED')
    expect(c.outbox).toHaveLength(1)
    expect(c.outbox[0].text).toMatch(/reply within one working day/)
    expect(owner.find(x => x.agentKey === 'returns')!.whatIDid.join(' ')).toMatch(/Your decision: Approve or decline the return on #1205\?/)
    const r = await decideCommerceWork(NW.org, row.id, 'decline', 'owner@test')
    expect(r).toMatchObject({ ok: true, status: 'done' })
    c = await commerce(NW)
    expect(c.returns[0].status).toBe('DECLINED')
    expect(c.outbox[1].text).toMatch(/not able to accept this return: requested 45 days after delivery/)
    expect(c.refunds).toHaveLength(0)
  })

  it('a return the customer says was used: outside policy, nothing approved', async () => {
    await resetCommerce(NW, ['return_in_policy'])
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    await mutateSynthetic(NW.conn, s => { s.commerce!.returns[0].note = 'Worn once and washed'; s.commerce!.returns[0].reason = 'UNWANTED' })
    await sweep()
    const [row] = await work(NW, 'return_outside_policy')
    expect(row.summary).toMatch(/the customer says it has been used/)
    expect((await commerce(NW)).returns[0].status).toBe('REQUESTED')
  })

  it('a weak description: Listing Writer rewrites it from the product facts on products/update, never invents, and undo restores it', async () => {
    await resetCommerce(NW, ['weak_description'])
    await deliver(event(NW, 'products/update', { admin_graphql_api_id: COMMERCE_IDS.candle.product }))
    const [row] = await work(NW, 'weak_description')
    expect(row.status).toBe('done')
    const html = (await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml!
    expect(html).toBe('<p>The Fig Leaf Candle from Lumen Works is part of our candles range.</p><p>Made from soy wax.</p>')
    expect(html).not.toMatch(/best|award|guarantee|perfect|luxur|hand-?made|organic/i)
    expect(row.payload.undo).toMatchObject({ kind: 'commerce.restore_description', payload: { html: '<p>Nice candle.</p>' } })
    recordLatency('weak_description', [row])
    expect(await undoCommerceWork(NW.org, row.id, 'test')).toMatchObject({ ok: true })
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toBe('<p>Nice candle.</p>')
  })

  it('a product with no facts to write from: nothing is written, the owner is asked for the facts', async () => {
    await resetCommerce(NW, ['thin_facts_description'])
    await sweep()
    const [row] = await work(NW, 'thin_facts_description')
    expect(row.status).toBe('draft')
    expect((await commerce(NW)).info['gid://shopify/Product/3099'].descriptionHtml).toBe('')
  })

  it('an out-of-stock product still promoted: Campaign and Promo Manager both see it; exactly one removes it from Featured; undo puts it back', async () => {
    await resetCommerce(NW, ['promoted_out_of_stock'])
    await deliver(event(NW, 'inventory_levels/update', { inventory_item_id: 5003, available: 0 }))
    const rows = await work(NW, 'promoted_out_of_stock')
    expect(rows).toHaveLength(1)
    expect(['campaign', 'promo_manager']).toContain(rows[0].agent_key)
    const featured = (await commerce(NW)).collections.find(c => c.id === COMMERCE_IDS.featured)!
    expect(featured.productIds).not.toContain(COMMERCE_IDS.lantern.product)
    expect(owner.filter(u => /Brass Lantern is out of stock/.test(u.headline))).toHaveLength(1)
    recordLatency('promoted_out_of_stock', rows)
    expect(await undoCommerceWork(NW.org, rows[0].id, 'test')).toMatchObject({ ok: true })
    expect((await commerce(NW)).collections.find(c => c.id === COMMERCE_IDS.featured)!.productIds).toContain(COMMERCE_IDS.lantern.product)
  })

  it('two agents on the same product at the same time: the shared key and lock let only one act', async () => {
    await resetCommerce(NW, ['promoted_out_of_stock'])
    const e = event(NW, 'inventory_levels/update', { inventory_item_id: 5003 })
    const r = await Promise.all([runCommerceAgent('campaign', e), runCommerceAgent('promo_manager', e)])
    const statuses = r.flatMap(x => x.outcomes.map(o => o.status)).sort()
    expect(statuses).toEqual(['already_handled', 'done'])
    expect(await work(NW, 'promoted_out_of_stock')).toHaveLength(1)
  })

  it('an expired discount still advertised: Promo Manager switches it off and clears the banner; undo restores both', async () => {
    await resetCommerce(NW, ['expired_discount_advertised'])
    await sweep()
    const [row] = await work(NW, 'expired_discount_advertised')
    expect(row).toMatchObject({ agent_key: 'promo_manager', status: 'done' })
    expect(row.payload.actionType).toBe('discount')
    let c = await commerce(NW)
    expect(c.discounts.find(d => d.code === 'SUMMER20')!.status).toBe('EXPIRED')
    expect(c.discounts.find(d => d.code === 'WELCOME10')!.status).toBe('ACTIVE')
    expect(c.announcement).toBeNull()
    const u = owner.find(x => x.agentKey === 'promo_manager')!
    expect(u.headline).toMatch(/^SUMMER20 ended \d{4}-\d{2}-\d{2} but was still on your banner; I switched it off$/)
    expect(u.proof.map(p => `${p.label}: ${p.value}`)).toEqual(expect.arrayContaining(['Fresh read: SUMMER20: expired', 'Fresh read: banner: (none)']))
    recordLatency('expired_discount_advertised', [row])
    expect(await undoCommerceWork(NW.org, row.id, 'test')).toMatchObject({ ok: true })
    c = await commerce(NW)
    expect(c.discounts.find(d => d.code === 'SUMMER20')!.status).toBe('ACTIVE')
    expect(c.announcement).toBe('Summer sale: use SUMMER20 for 20% off everything')
  })

  it('a "where is my order" email: Customer Care replies with the tracking from the order, once, even if the mail event repeats', async () => {
    await resetCommerce(NW, ['wismo_email'])
    const e = event(NW, 'mail.received', { id: 'mail-wismo-1', from: 'ben@shopper.example' })
    await deliver(e)
    await deliver(e)
    const [row] = await work(NW, 'wismo_email')
    expect(row.status).toBe('done')
    const replies = (await commerce(NW)).outbox.filter(m => m.inReplyTo === 'mail-wismo-1')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ to: 'ben@shopper.example', subject: 'Re: Where is my order?' })
    expect(replies[0].text).toMatch(/^Hi Ben,/)
    expect(replies[0].text).toMatch(/#1102/)
    expect(replies[0].text).toMatch(/tracking number is FH900101/)
    expect(replies[0].text).toMatch(/delivered on/)
    recordLatency('wismo_email', [row])
  })

  it('a "where is my order" email from an address with no order: Customer Care asks for the order number', async () => {
    await resetCommerce(NW, ['wismo_email_unknown_order'])
    await sweep()
    const reply = (await commerce(NW)).outbox.find(m => m.inReplyTo === 'mail-wismo-2')!
    expect(reply.text).toMatch(/reply with your order number/)
  })

  it('a customer question that is not about order status is left for the owner, unanswered', async () => {
    await resetCommerce(NW)
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    await mutateSynthetic(NW.conn, s => { s.commerce!.mailbox.push({ id: 'mail-q-1', receivedAt: new Date().toISOString(), from: 'grace@shopper.example', to: 'hello@fernhill.example', subject: 'Is the throw machine washable?', text: 'Can I wash it?', inReplyTo: null }) })
    await sweep()
    expect((await work(NW, 'customer_message_for_owner'))[0].status).toBe('draft')
    expect((await commerce(NW)).outbox).toHaveLength(0)
  })

  it('a payout with fees above the rate: Payout and Fees Checker flags it and prepares the dispute with the figures', async () => {
    await resetCommerce(NW, ['payout_mismatch'])
    await sweep()
    const [row] = await work(NW, 'payout_mismatch')
    expect(row).toMatchObject({ agent_key: 'payout_fees_checker', status: 'done' })
    expect(row.payload.actionType).toBe('payout_dispute')
    expect(row.title).toMatch(/fees are \$9\.\d\d above your rate; dispute prepared/)
    const packet = String((row.payload.facts as { packet: string }).packet)
    expect(packet).toMatch(/expected \$[\d.]+ at 2\.9% \+ \$0\.30 on 5 orders/)
    expect(packet).toMatch(/Orders: 7101, 7102, 7103, 7104, 7105/)
    recordLatency('payout_mismatch', [row])
  })

  it('a payout that failed: flagged with the dispute prepared', async () => {
    await resetCommerce(NW, ['missing_payout'])
    await sweep()
    expect((await work(NW, 'missing_payout'))[0].title).toMatch(/failed and has not reached your bank/)
  })

  it('AI Visibility: a product without a search description gets one from its description, with the gaps only the owner can fill; undo clears it', async () => {
    await resetCommerce(NW, ['ai_visibility_gap'])
    await deliver(event(NW, 'products/update', { admin_graphql_api_id: COMMERCE_IDS.apron.product }))
    const [row] = await work(NW, 'ai_visibility_gap')
    expect(row.status).toBe('done')
    const seo = (await commerce(NW)).info[COMMERCE_IDS.apron.product].seoDescription!
    expect(seo.startsWith('A waxed cotton canvas apron made in the Fernhill Workshop')).toBe(true)
    expect(seo.length).toBeLessThanOrEqual(155)
    expect(row.payload.whatIDid).toEqual(expect.arrayContaining(['Still needs you: 2 images without alt text.']))
    recordLatency('ai_visibility_gap', [row])
    expect(await undoCommerceWork(NW.org, row.id, 'test')).toMatchObject({ ok: true })
    expect((await commerce(NW)).info[COMMERCE_IDS.apron.product].seoDescription).toBeNull()
  })

  it('Store Health Checker: the weekly report lists every problem the store has', async () => {
    await resetCommerce(NW, ['selling_past_zero', 'weak_description', 'stuck_order', 'expired_discount_advertised'])
    await runCommerceAgent('store_health_checker', event(NW, 'sweep'))
    const [row] = await work(NW, 'weekly_health')
    expect(row.title).toBe('Store health: 4 things to look at')
    const u = owner.find(x => x.agentKey === 'store_health_checker')!
    expect(u.whatIDid.join('\n')).toMatch(/Selling past zero: Seagrass Basket/)
    expect(u.whatIDid.join('\n')).toMatch(/Thin descriptions: Fig Leaf Candle/)
    expect(u.whatIDid.join('\n')).toMatch(/Orders late to ship: #1201/)
    expect(u.whatIDid.join('\n')).toMatch(/still active: SUMMER20/)
  })

  it('Weekly Insights: orders, revenue against last week, what sold and what is low', async () => {
    await resetCommerce(NW, ['best_seller_low_stock'])
    await runCommerceAgent('weekly_insights', event(NW, 'sweep'))
    const u = owner.find(x => x.agentKey === 'weekly_insights')!
    expect(u.whatIDid.join('\n')).toMatch(/Sold most: .*Wool Throw Blanket/)
    expect(u.whatIDid.join('\n')).toMatch(/Running low: Wool Throw Blanket/)
  })

  it('every scenario seeded together: one sweep handles each, and a second sweep does nothing new', async () => {
    await resetCommerce(NW, ['best_seller_low_stock', 'selling_past_zero', 'restock_no_reply', 'stuck_order', 'tracking_stalled', 'return_in_policy', 'return_damaged', 'return_outside_policy', 'weak_description', 'promoted_out_of_stock', 'expired_discount_advertised', 'wismo_email', 'payout_mismatch', 'ai_visibility_gap'])
    const t0 = Date.now()
    const results = await sweepCommerce(NW.org)
    const ms = Date.now() - t0
    const kinds = (await work(NW)).map(r => r.action_type)
    for (const k of ['best_seller_low_stock', 'selling_past_zero', 'restock_no_reply', 'stuck_order', 'tracking_stalled', 'return_in_policy', 'return_damaged', 'return_outside_policy', 'weak_description', 'promoted_out_of_stock', 'expired_discount_advertised', 'wismo_email', 'payout_mismatch', 'ai_visibility_gap', 'weekly_health', 'weekly_insights']) expect(kinds, k).toContain(k)
    expect(results.every(r => r.status === 'ran')).toBe(true)
    expect(results.flatMap(r => r.outcomes).filter(o => o.status === 'failed')).toEqual([])
    const before = (await work(NW)).length
    await sweepCommerce(NW.org)
    expect((await work(NW)).length).toBe(before)
    latencies.full_sweep_all_scenarios_total = ms
  })

  it('stays inside the organization: a sweep of one merchant never writes to another', async () => {
    await resetCommerce(NW, ['weak_description'])
    const hbBefore = await work(HB)
    await sweep()
    expect(await work(HB)).toEqual(hbBefore)
  })
})

describe.skipIf(!ready)('commerce pack: ask first', () => {
  beforeEach(() => { modes.clear() })

  it('ask_first for listing changes: nothing is written, the owner gets the prepared change; approving it writes and verifies', async () => {
    modes.set('update_listing', 'ask_first')
    await resetCommerce(NW, ['weak_description'])
    await sweep()
    const [row] = await work(NW, 'weak_description')
    expect(row).toMatchObject({ status: 'draft', mode: 'draft', status_reason: 'ask first: waiting for the owner' })
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toBe('<p>Nice candle.</p>')
    const u = owner.find(x => x.agentKey === 'listing_writer')!
    expect(u.severity).toBe('action')
    expect(u.whatIDid[0]).toBe('Prepared this for you; nothing has been done yet.')
    await sweep()
    expect(await work(NW, 'weak_description')).toHaveLength(1)
    const r = await decideCommerceWork(NW.org, row.id, 'approve', 'owner@test')
    expect(r.ok).toBe(true)
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toMatch(/Lumen Works/)
    const [after] = await work(NW, 'weak_description')
    expect(after.status).toBe('done')
    expect(after.payload.undo).toMatchObject({ kind: 'commerce.restore_description' })
  })

  it('a money action in ask_first: a damaged-item refund waits; nothing is refunded until approved', async () => {
    modes.set('refund', 'ask_first')
    await resetCommerce(NW, ['return_damaged'])
    await deliver(event(NW, 'returns/request', { admin_graphql_api_id: 'gid://shopify/Return/8202' }))
    const [row] = await work(NW, 'return_damaged')
    expect(row.status).toBe('draft')
    let c = await commerce(NW)
    expect(c.refunds).toHaveLength(0)
    expect(c.returns[0].status).toBe('REQUESTED')
    expect(c.outbox).toHaveLength(0)
    await decideCommerceWork(NW.org, row.id, 'approve', 'owner@test')
    c = await commerce(NW)
    expect(c.refunds).toHaveLength(1)
    expect(c.returns[0].status).toBe('OPEN')
  })

  it('a money action in ask_first, declined: the discount stays as it is', async () => {
    modes.set('discount', 'ask_first')
    await resetCommerce(NW, ['expired_discount_advertised'])
    await sweep()
    const [row] = await work(NW, 'expired_discount_advertised')
    expect(row.status).toBe('draft')
    expect(await decideCommerceWork(NW.org, row.id, 'decline', 'owner@test')).toMatchObject({ status: 'declined' })
    expect((await commerce(NW)).discounts.find(d => d.code === 'SUMMER20')!.status).toBe('ACTIVE')
    await sweep()
    expect(await work(NW, 'expired_discount_advertised')).toHaveLength(1)
  })

  it('approval of a problem that went away meanwhile does nothing', async () => {
    modes.set('update_listing', 'ask_first')
    await resetCommerce(NW, ['weak_description'])
    await sweep()
    const [row] = await work(NW, 'weak_description')
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    await mutateSynthetic(NW.conn, s => { s.commerce!.info[COMMERCE_IDS.candle.product].descriptionHtml = '<p>The merchant wrote a long and careful description of this candle themselves, with every detail a shopper needs to know.</p>' })
    expect(await decideCommerceWork(NW.org, row.id, 'approve', 'owner@test')).toMatchObject({ ok: false, status: 'expired' })
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toMatch(/merchant wrote/)
  })
})

describe.skipIf(!ready)('commerce pack: failures', () => {
  beforeEach(() => { modes.clear() })

  it('a write Shopify refuses: logged as failed, no "done" update; retried on the next event and then done', async () => {
    await resetCommerce(NW, ['weak_description'])
    await injectFault(NW.conn, { op: 'commerce.setDescription', mode: 'user_error' })
    await sweep()
    let rows = await work(NW, 'weak_description')
    expect(rows[0]).toMatchObject({ status: 'failed' })
    expect(rows[0].status_reason).toMatch(/refused/)
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toBe('<p>Nice candle.</p>')
    // the shared loop tells the owner once that the agent could not finish (never a "done" update), and retries later
    const told = owner.filter(u => u.agentKey === 'listing_writer')
    expect(told).toHaveLength(1)
    expect(told[0].headline).not.toMatch(/done/i)
    // before the retry time a sweep does not hammer Shopify
    await sweep()
    expect((await work(NW, 'weak_description')).map(r => r.status)).toEqual(['failed'])
    // once the retry is due, the next event runs it again and it goes through
    await admin(db => db.query(`update agent_loops set next_retry_at = now() - interval '1 minute' where org_id = $1 and state = 'blocked'`, [NW.org]))
    await sweep()
    rows = await work(NW, 'weak_description')
    expect(rows.map(r => r.status)).toEqual(['failed', 'done'])
  })

  it('a write that does not stick: the fresh read catches it, the owner is warned, nothing is claimed as done', async () => {
    await resetCommerce(NW, ['promoted_out_of_stock'])
    await injectFault(NW.conn, { op: 'commerce.removeFromCollection', mode: 'write_does_not_stick' })
    await runCommerceAgent('campaign', event(NW, 'sweep'))
    const [row] = await work(NW, 'promoted_out_of_stock')
    expect(row).toMatchObject({ status: 'failed', status_reason: 'the fresh read did not confirm the change' })
    expect(row.proof!.items.map(p => p.value)).toContain('still contains the product')
    const u = owner.find(x => x.agentKey === 'campaign')!
    expect(u.severity).toBe('warning')
  })

  it('a packer message that fails: the stuck order is retried without emailing the customer a second time', async () => {
    // found by scripts/scenario-harness.ts (A05): the retry re-ran the whole act and sent the delay email again.
    // The failure is real: the crew email goes live and the mail provider refuses it (a fake HTTP transport).
    await resetCommerce(NW, ['stuck_order'])
    const { setEmailFetch } = await import('../../lib/email/adapters/http')
    const saved = { key: process.env.RESEND_API_KEY, live: process.env.EMAIL_LIVE_SENDS }
    process.env.RESEND_API_KEY = 're_test_key'; process.env.EMAIL_LIVE_SENDS = 'all'
    setEmailFetch(async () => new Response(JSON.stringify({ message: 'bad request' }), { status: 422 }))
    try {
      await sweep()
      expect((await work(NW, 'stuck_order')).map(r => r.status)).toEqual(['failed'])
      expect((await crewSent(NW)).map(m => m.status)).toEqual(['failed'])
      await admin(db => db.query(`update agent_loops set next_retry_at = now() - interval '1 minute' where org_id = $1 and state = 'blocked'`, [NW.org]))
      await sweep()
      expect((await work(NW, 'stuck_order')).map(r => r.status)).toEqual(['failed', 'failed'])
      expect((await commerce(NW)).outbox.filter(m => m.to === 'kit@shopper.example')).toHaveLength(1)
    } finally {
      setEmailFetch(null)
      if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key
      if (saved.live === undefined) delete process.env.EMAIL_LIVE_SENDS; else process.env.EMAIL_LIVE_SENDS = saved.live
    }
  })

  it('a throttled store: the call is waited out and the work still completes', async () => {
    await resetCommerce(NW, ['selling_past_zero'])
    await injectFault(NW.conn, { op: 'commerce.setInventoryPolicy', mode: 'throttle_once' })
    await runCommerceAgent('inventory_watcher', event(NW, 'sweep'))
    expect((await work(NW, 'selling_past_zero'))[0].status).toBe('done')
  })

  it('the app uninstalled mid-run: the action fails, the rest of the run stops, and later events skip the store', async () => {
    await resetCommerce(NW, ['weak_description', 'thin_facts_description'])
    const { mutateSynthetic } = await import('../../lib/connectors/shopify/synthetic')
    // a second weak product so the run has more work after the uninstall
    await mutateSynthetic(NW.conn, s => { s.commerce!.info[COMMERCE_IDS.mug.product].descriptionHtml = '<p>Mug.</p>' })
    await injectFault(NW.conn, { op: 'commerce.setDescription', mode: 'uninstall_mid_run' })
    const r = await runCommerceAgent('listing_writer', event(NW, 'sweep'))
    const statuses = r.outcomes.map(o => o.status)
    expect(statuses[0]).toBe('failed')
    expect(r.outcomes[0].error).toMatch(/^uninstalled/)
    expect(statuses.slice(1).every(s => s === 'skipped_uninstalled')).toBe(true)
    expect(statuses.length).toBeGreaterThan(1)
    expect((await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1', [NW.conn])))!.status).toBe('uninstalled')
    expect(await runCommerceAgent('listing_writer', event(NW, 'sweep'))).toMatchObject({ status: 'skipped', reason: 'no active Shopify store' })
    await admin(db => db.query(`update store_connections set status = 'active', status_reason = null where id = $1`, [NW.conn]))
  })

  it('an agent the owner switched off does not run, and "stop all agents" stops the pack', async () => {
    await resetCommerce(NW, ['weak_description'])
    await admin(db => db.query(`insert into library_switches (org_id, agent_key, enabled) values ($1, 'listing_writer', false) on conflict (org_id, agent_key) do update set enabled = false`, [NW.org]))
    expect(await runCommerceAgent('listing_writer', event(NW, 'sweep'))).toMatchObject({ status: 'skipped', reason: 'switched off' })
    await admin(db => db.query(`delete from library_switches where org_id = $1`, [NW.org]))
    await admin(db => db.query(`insert into org_controls (org_id, agents_stopped, stop_reason) values ($1, true, 'test') on conflict (org_id) do update set agents_stopped = true, stop_reason = 'test'`, [NW.org]))
    try { expect((await runCommerceAgent('listing_writer', event(NW, 'sweep'))).status).toBe('skipped') }
    finally { await admin(db => db.query(`update org_controls set agents_stopped = false where org_id = $1`, [NW.org])) }
    expect((await commerce(NW)).info[COMMERCE_IDS.candle.product].descriptionHtml).toBe('<p>Nice candle.</p>')
  })

  it('an unreadable store: the agent reports failed and nothing is logged as done', async () => {
    await resetCommerce(NW, ['weak_description'])
    await injectFault(NW.conn, { op: 'commerce.products', mode: 'read_error' })
    const r = await runCommerceAgent('listing_writer', event(NW, 'sweep'))
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/unreadable/)
    expect(await work(NW, 'weak_description')).toHaveLength(0)
  })

  it('a refund above the automatic limit goes to the owner, even in act-and-tell', async () => {
    await resetCommerce(NW, ['return_damaged'])
    await admin(db => db.query(`insert into library_switches (org_id, agent_key, enabled, settings) values ($1, 'returns', true, '{"refundCap": 10}') on conflict (org_id, agent_key) do update set enabled = true, settings = '{"refundCap": 10}'`, [NW.org]))
    await sweep()
    const [row] = await work(NW, 'return_outside_policy')
    expect(row.summary).toMatch(/above your automatic limit of \$10\.00/)
    expect((await commerce(NW)).refunds).toHaveLength(0)
  })
})
