/** Shopify webhooks become agent events: HMAC first, receipt dedupe, event-id dedupe, compliance topics untouched. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { SHOPIFY_EVENT_TOPICS, EVENT_TOPIC_SCOPES } from '../../lib/connectors/shopify/config'
import { onEvent, offEvent, type AgentEvent } from '../../lib/events'
import { NW, resetMerchant } from '../merchant/helpers'
import { cleanW1 } from './helpers'

const ready = await prepareDb()
/** delivery and event ids unique per run (webhook receipts are kept between runs) */
const R = Date.now().toString(36)
const u = (id: string) => `${id}-${R}`
const SECRET = process.env.SHOPIFY_API_SECRET!

function webhook(topic: string, body: unknown, o: { id?: string; eventId?: string; secret?: string } = {}) {
  const raw = JSON.stringify(body)
  const h: Record<string, string> = { 'x-shopify-topic': topic, 'x-shopify-shop-domain': NW.domain, 'x-shopify-webhook-id': o.id ?? `wh-${Math.random().toString(36).slice(2)}`, 'content-type': 'application/json',
    'x-shopify-hmac-sha256': createHmac('sha256', o.secret ?? SECRET).update(raw).digest('base64'), 'x-shopify-triggered-at': '2026-11-07T09:00:00Z' }
  if (o.eventId) h['x-shopify-event-id'] = o.eventId
  return new Request('http://localhost/api/shopify/webhooks', { method: 'POST', body: raw, headers: h })
}
const collect = () => { const fns: (() => Promise<void>)[] = []; return { defer: (fn: () => Promise<void>) => { fns.push(fn) }, run: async () => { for (const f of fns.splice(0)) await f() } } }
const events = () => admin(db => db.query<{ type: string; external_id: string; duplicates: number; occurred_at: string; payload: Record<string, unknown> }>(`select type, external_id, duplicates, occurred_at, payload from agent_events where org_id = $1 and source = 'shopify' order by received_at`, [NW.org]))
const receipt = (id: string) => admin(db => db.one<{ status: string; note: string }>(`select status, note from webhook_receipts where platform = 'shopify' and delivery_id = $1`, [id]))

describe('the agent topics and their scopes', () => {
  it('cover orders, fulfillments, inventory, products, customers, refunds, returns and discounts', () => {
    for (const t of ['orders/create', 'orders/updated', 'orders/fulfilled', 'fulfillments/create', 'fulfillments/update', 'inventory_levels/update', 'products/update', 'customers/create', 'customers/update', 'refunds/create', 'returns/request', 'discounts/create', 'discounts/update'])
      expect(SHOPIFY_EVENT_TOPICS.has(t), t).toBe(true)
    expect(EVENT_TOPIC_SCOPES['orders/create']).toEqual({ scope: 'read_orders', protectedData: true })
    expect(EVENT_TOPIC_SCOPES['discounts/create']).toEqual({ scope: 'read_discounts', protectedData: false })
    for (const t of ['customers/data_request', 'customers/redact', 'shop/redact', 'app/uninstalled']) expect(SHOPIFY_EVENT_TOPICS.has(t)).toBe(false)
  })
})

describe.skipIf(!ready)('Shopify webhooks into the event router', () => {
  const seen: AgentEvent[] = []
  beforeEach(async () => { await cleanW1(); await resetMerchant(NW); seen.length = 0; onEvent('orders/create', 'w1-orders', async (_db, e) => { seen.push(e) }) })
  afterAll(async () => { offEvent('orders/create', 'w1-orders'); await cleanW1() })

  it('a signed orders/create becomes one event and one job for the listening agent, run right after the response', async () => {
    const c = collect()
    const res = await handleShopifyWebhook(webhook('orders/create', { id: 1001, name: '#1001', email: 'jo@buyer.example' }, { id: u('wh-o-1'), eventId: u('ev-o-1') }), c.defer)
    expect(res.status).toBe(200)
    expect(await receipt(u('wh-o-1'))).toMatchObject({ status: 'processed', note: expect.stringMatching(/^routed to \d+ agent\(s\)$/) })
    const ev = await events()
    expect(ev.map(e => [e.type, e.external_id, e.duplicates])).toEqual([['orders/create', u('ev-o-1'), 0]])
    expect(new Date(ev[0].occurred_at).toISOString()).toBe('2026-11-07T09:00:00.000Z')
    expect(ev[0].payload).toMatchObject({ id: 1001, name: '#1001', _deploi: { shop: NW.domain, connectionId: NW.conn, webhookId: u('wh-o-1'), topic: 'orders/create' } })
    expect(seen).toHaveLength(0)
    await c.run()
    expect(seen.map(e => [e.source, e.type, e.orgId, e.payload.name])).toEqual([['shopify', 'orders/create', NW.org, '#1001']])
  })

  it('the same delivery twice is acknowledged once (receipts); the same event under a new delivery id is a recorded duplicate (router)', async () => {
    const body = { id: 1002, name: '#1002' }
    expect((await handleShopifyWebhook(webhook('orders/create', body, { id: u('wh-o-2'), eventId: u('ev-o-2') }), () => undefined)).status).toBe(200)
    const again = await handleShopifyWebhook(webhook('orders/create', body, { id: u('wh-o-2'), eventId: u('ev-o-2') }), () => undefined)
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    expect((await handleShopifyWebhook(webhook('orders/create', body, { id: u('wh-o-2b'), eventId: u('ev-o-2') }), () => undefined)).status).toBe(200)
    expect(await receipt(u('wh-o-2b'))).toMatchObject({ note: 'event already routed' })
    expect((await events()).map(e => [e.external_id, e.duplicates])).toEqual([[u('ev-o-2'), 1]])
    expect(await admin(db => db.one<{ n: number }>(`select count(*)::int as n from jobs where kind = 'event.handle' and org_id = $1 and payload->>'agentKey' = 'w1-orders'`, [NW.org]))).toEqual({ n: 1 })
  })

  it('a bad signature is refused before anything is recorded; compliance topics are handled as before, never routed', async () => {
    const bad = await handleShopifyWebhook(webhook('orders/create', { id: 1 }, { id: u('wh-bad'), secret: 'not-the-secret' }), () => undefined)
    expect(bad.status).toBe(401)
    expect(await receipt(u('wh-bad'))).toBeNull()
    expect(await events()).toEqual([])
    const red = await handleShopifyWebhook(webhook('customers/redact', { shop_domain: NW.domain, customer: { id: 5, email: 'nobody@buyer.example' }, orders_to_redact: [] }, { id: u('wh-red') }), () => undefined)
    expect(red.status).toBe(200)
    expect(await receipt(u('wh-red'))).toMatchObject({ status: 'processed' })
    expect(await events()).toEqual([])
  })

  it('topics without a listener are recorded for the agents; products/update still queues its rescan too; an unknown topic is ignored', async () => {
    await handleShopifyWebhook(webhook('refunds/create', { id: 9, order_id: 1001 }, { id: u('wh-r-1') }), () => undefined)
    expect(await receipt(u('wh-r-1'))).toMatchObject({ status: 'processed', note: expect.stringMatching(/^(event recorded; no agent listens to it|routed to \d+ agent\(s\))$/) })
    await handleShopifyWebhook(webhook('products/update', { admin_graphql_api_id: 'gid://shopify/Product/1001' }, { id: u('wh-p-1') }), () => undefined)
    expect((await receipt(u('wh-p-1')))!.note).toMatch(/^queued a targeted rescan of 1 record\(s\).*; (event recorded|routed to)/)
    await handleShopifyWebhook(webhook('carts/update', { id: 3 }, { id: u('wh-cart') }), () => undefined)
    expect(await receipt(u('wh-cart'))).toMatchObject({ status: 'ignored' })
    expect((await events()).map(e => [e.type, e.external_id])).toEqual([['refunds/create', u('wh-r-1')], ['products/update', u('wh-p-1')]])
    await admin(db => db.query('delete from shopify_rescan_queue where connection_id = $1', [NW.conn]))
  })
})
