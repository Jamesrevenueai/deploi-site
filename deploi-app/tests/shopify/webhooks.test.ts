import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { flushRescans } from '../../lib/connectors/shopify/rescans'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { startConnect, completeConnect } from '../../lib/email/accounts'
import { syntheticCode, SYNTH_SEND } from '../../lib/email/adapters/synthetic'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { NW, HB, merchantActor, resetMerchant } from '../merchant/helpers'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const { P, I } = NORTHWIND_IDS as unknown as { P: (n: number) => string; I: (n: number) => string }

function webhook(topic: string, shop: string, body: unknown, id = `wh-${Math.random().toString(36).slice(2)}`) {
  const raw = JSON.stringify(body)
  return new Request('http://localhost/api/shopify/webhooks', { method: 'POST', body: raw, headers: {
    'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': id, 'content-type': 'application/json', 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64') } })
}
const collect = () => { const fns: (() => Promise<void>)[] = []; return { defer: (fn: () => Promise<void>) => { fns.push(fn) }, run: async () => { for (const f of fns.splice(0)) await f() } } }
const queue = (conn: string) => admin(db => db.query<{ resource_id: string; hits: number; topics: string[] }>('select resource_id, hits, topics from shopify_rescan_queue where connection_id = $1 order by resource_id', [conn]))
const targetedScans = (conn: string) => admin(db => db.one<{ n: string }>(`select count(*)::text as n from scans where connection_id = $1 and scope = 'targeted'`, [conn])).then(r => Number(r!.n))
const receipt = (id: string) => admin(db => db.one<{ status: string; note: string }>(`select status, note from webhook_receipts where platform = 'shopify' and delivery_id = $1`, [id]))

describe.skipIf(!ready)('Shopify webhooks: debounced rescans, uninstall, compliance and billing', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB); await admin(db => db.query('delete from shopify_rescan_queue')) })
  afterEach(() => { delete process.env.SHOPIFY_WEBHOOK_DEBOUNCE_MS; delete process.env.SHOPIFY_WEBHOOK_MAX_DELAY_MS })

  it('a burst of inventory and product webhooks becomes one targeted rescan after the quiet period', async () => {
    process.env.SHOPIFY_WEBHOOK_DEBOUNCE_MS = '600000'
    const c = collect()
    const before = await targetedScans(NW.conn)
    for (let i = 0; i < 3; i++) expect((await handleShopifyWebhook(webhook('inventory_levels/update', NW.domain, { inventory_item_id: Number(I(2001).split('/').pop()), available: i }), c.defer)).status).toBe(200)
    const pid = 'wh-products-update-burst-' + Date.now()
    await handleShopifyWebhook(webhook('products/update', NW.domain, { admin_graphql_api_id: P(1001) }, pid), c.defer)
    expect(await receipt(pid)).toMatchObject({ status: 'processed', note: expect.stringMatching(/queued a targeted rescan/) })
    const q = await queue(NW.conn)
    expect(q.map(r => [r.resource_id, r.hits])).toEqual([[I(2001), 3], [P(1001), 1]])
    // still inside the quiet period: nothing is read
    expect(await flushRescans({ connectionId: NW.conn })).toEqual([])
    expect(await targetedScans(NW.conn)).toBe(before)
    // a record that keeps changing is read no later than the maximum delay after its first webhook
    process.env.SHOPIFY_WEBHOOK_MAX_DELAY_MS = '0'
    await handleShopifyWebhook(webhook('inventory_levels/update', NW.domain, { inventory_item_id: Number(I(2001).split('/').pop()) }), c.defer)
    process.env.SHOPIFY_WEBHOOK_DEBOUNCE_MS = '0'
    await handleShopifyWebhook(webhook('products/update', NW.domain, { admin_graphql_api_id: P(1001) }), c.defer)
    await c.run() // every webhook's deferred flush: only the first finds anything due
    expect(await targetedScans(NW.conn)).toBe(before + 1)
    expect(await queue(NW.conn)).toEqual([])
    expect(await flushRescans()).toEqual([])
  })

  it('records for an inactive connection are not queued; uninstall drops queued rescans and cancels the subscription', async () => {
    const shop = `wh-ops-${Date.now()}.myshopify.com`
    const r = await ensureInstalled(shop, 'id-token', { exchange: async () => ({ accessToken: 'shpat_x', scope: ['read_products'], expiresIn: 3600, refreshToken: 'shprt_x', refreshTokenExpiresIn: 7776000 }), info: async () => ({ name: 'Ops (synthetic)', timezone: 'UTC' }) })
    process.env.SHOPIFY_WEBHOOK_DEBOUNCE_MS = '600000'
    await handleShopifyWebhook(webhook('products/update', shop, { admin_graphql_api_id: 'gid://shopify/Product/77' }), () => undefined)
    expect(await queue(r.connectionId)).toHaveLength(1)
    await admin(db => db.query(`insert into app_subscriptions (org_id, connection_id, provider, plan_key, status, external_id) values ($1,$2,'shopify_billing','growth','active',$3)`, [r.orgId, r.connectionId, `app_pricing:${shop}`]))
    expect((await handleShopifyWebhook(webhook('app/uninstalled', shop, { id: 1 }), () => undefined)).status).toBe(200)
    expect(await queue(r.connectionId)).toEqual([])
    expect(await admin(db => db.one('select status from app_subscriptions where connection_id = $1', [r.connectionId]))).toMatchObject({ status: 'cancelled' })
    const id = 'wh-after-uninstall-' + Date.now()
    await handleShopifyWebhook(webhook('products/update', shop, { admin_graphql_api_id: 'gid://shopify/Product/77' }, id), () => undefined)
    expect(await receipt(id)).toMatchObject({ status: 'ignored', note: 'the connection is uninstalled' })
  })

  it('customers/data_request reports what is held; customers/redact deletes it; neither keeps the address', async () => {
    const actor = await merchantActor(NW)
    const { url } = await startConnect(actor, { provider: 'synthetic' })
    const acc = (await completeConnect(actor, { state: new URL(url, 'http://x').searchParams.get('state')!, code: syntheticCode('agent@northwind-goods.example', [SYNTH_SEND]), error: null })).account
    const CUSTOMER = 'Shopper@Buyer.example'
    for (const [i, from] of [[1, 'shopper@buyer.example'], [2, 'shopper@buyer.example'], [3, 'someone@else.example']] as const)
      await admin(db => db.query(`insert into email_inbound (org_id, account_id, provider_email_id, from_address, classification, status, key_id, content_ciphertext, received_at) values ($1,$2,$3,$4,'other','quarantined','k','c',now())`, [NW.org, acc.id, `p-${i}`, from]))
    // Harbor holds mail from the same address: another organization, never touched
    const hbActor = await merchantActor(HB)
    const s2 = await startConnect(hbActor, { provider: 'synthetic' })
    const hbAcc = (await completeConnect(hbActor, { state: new URL(s2.url, 'http://x').searchParams.get('state')!, code: syntheticCode('agent@harbor-supply.example', [SYNTH_SEND]), error: null })).account
    await admin(db => db.query(`insert into email_inbound (org_id, account_id, provider_email_id, from_address, classification, status, key_id, content_ciphertext, received_at) values ($1,$2,'p-hb','shopper@buyer.example','other','quarantined','k','c',now())`, [HB.org, hbAcc.id]))

    const body = { shop_id: 1, shop_domain: NW.domain, customer: { id: 42, email: CUSTOMER, phone: null }, orders_requested: [] }
    const dr = `wh-data-request-${Date.now()}`
    expect((await handleShopifyWebhook(webhook('customers/data_request', NW.domain, body, dr), () => undefined)).status).toBe(200)
    const req = await admin(db => db.one<{ status: string; result: Record<string, unknown>; subject_hash: string }>('select status, result, subject_hash from shopify_compliance_requests where webhook_id = $1', [dr]))
    expect(req).toMatchObject({ status: 'completed', result: { customer_data_held: true, inbound_messages: 2, sent_messages: 0 } })
    expect(req!.subject_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(req)).not.toMatch(/buyer\.example/i)
    const ev = await admin(db => db.one<{ detail: Record<string, unknown> }>(`select detail from engine_audit where org_id = $1 and event = 'compliance.customers.data_request' order by id desc limit 1`, [NW.org]))
    expect(ev!.detail).toMatchObject({ inbound_messages: 2 })

    const rd = `wh-redact-${Date.now()}`
    expect((await handleShopifyWebhook(webhook('customers/redact', NW.domain, { ...body, orders_to_redact: [] }, rd), () => undefined)).status).toBe(200)
    expect((await handleShopifyWebhook(webhook('customers/redact', NW.domain, body, rd), () => undefined)).status).toBe(200) // duplicate delivery
    const left = await admin(db => db.query<{ org_id: string; from_address: string }>(`select org_id, from_address from email_inbound where account_id = any($1::uuid[]) order by from_address`, [[acc.id, hbAcc.id]]))
    expect(left).toEqual([{ org_id: HB.org, from_address: 'shopper@buyer.example' }, { org_id: NW.org, from_address: 'someone@else.example' }])
    expect(await admin(db => db.one('select result from shopify_compliance_requests where webhook_id = $1', [rd]))).toMatchObject({ result: { inbound_deleted: 2, sent_deleted: 0 } })
    // a request with no address, or for a shop that is not connected, holds nothing
    await handleShopifyWebhook(webhook('customers/data_request', 'never-installed.myshopify.com', body, `wh-none-${Date.now()}`), () => undefined)
    expect(await admin(db => db.one(`select result from shopify_compliance_requests where shop = 'never-installed.myshopify.com' order by received_at desc limit 1`))).toMatchObject({ result: { customer_data_held: false } })
  })

  it('shop/redact for a shop that reinstalled keeps its data; after uninstall it erases it', async () => {
    const id = `wh-shop-redact-${Date.now()}`
    expect((await handleShopifyWebhook(webhook('shop/redact', NW.domain, { shop_id: 1, shop_domain: NW.domain }, id), () => undefined)).status).toBe(200)
    expect(await admin(db => db.one('select status from store_connections where id = $1', [NW.conn]))).toMatchObject({ status: 'active' })
    expect(await admin(db => db.one('select status, result from shopify_compliance_requests where webhook_id = $1', [id]))).toMatchObject({ status: 'deferred', result: { shop_data_erased: false, skipped: expect.stringMatching(/reinstalled/) } })
    expect(await receipt(id)).toMatchObject({ status: 'processed', note: expect.stringMatching(/reinstalled/) })

    const shop = `wh-redact-${Date.now()}.myshopify.com`
    const r = await ensureInstalled(shop, 'id-token', { exchange: async () => ({ accessToken: 'shpat_y', scope: ['read_products'], expiresIn: 3600, refreshToken: null, refreshTokenExpiresIn: null }), info: async () => ({ name: 'Redact (synthetic)', timezone: 'UTC' }) })
    await handleShopifyWebhook(webhook('app/uninstalled', shop, { id: 2 }), () => undefined)
    const id2 = `wh-shop-redact2-${Date.now()}`
    await handleShopifyWebhook(webhook('shop/redact', shop, { shop_domain: shop }, id2), () => undefined)
    expect(await admin(db => db.one('select 1 from store_connections where id = $1', [r.connectionId]))).toBeNull()
    expect(await admin(db => db.one('select status, connection_id, org_id, result from shopify_compliance_requests where webhook_id = $1', [id2]))).toMatchObject({ status: 'completed', connection_id: null, org_id: null, result: { shop_data_erased: true, organization_erased: true } })
  })

  it('app_subscriptions/update only re-reads the subscription (nothing changes without a Partner API answer)', async () => {
    const id = `wh-sub-${Date.now()}`
    expect((await handleShopifyWebhook(webhook('app_subscriptions/update', NW.domain, { app_subscription: { status: 'ACTIVE', name: 'Growth' } }, id), () => undefined)).status).toBe(200)
    expect(await receipt(id)).toMatchObject({ status: 'processed', note: 'subscription re-read from Shopify' })
    expect(await admin(db => db.query(`select 1 from app_subscriptions where connection_id = $1 and provider = 'shopify_billing'`, [NW.conn]))).toEqual([])
  })
})
