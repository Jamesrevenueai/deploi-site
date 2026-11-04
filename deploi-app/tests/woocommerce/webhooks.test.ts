/**
 * WooCommerce webhook deliveries: signature verification over the raw body, the unsigned creation ping,
 * replay de-duplication, deliveries for another connection, and the targeted rescan a delivery triggers.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { connectStore } from '../../lib/connectors/woocommerce/connect'
import { handleWooWebhook, webhookSignature } from '../../lib/connectors/woocommerce/webhooks'
import { fakeWooTransport, type WooSynthState } from '../../lib/connectors/woocommerce/synthetic'
import { setWooTransportOverride } from '../../lib/connectors/woocommerce/client'
import { wooDemoState } from '../../lib/connectors/woocommerce/demo-store'
import { WOO_OVERSOLD_CHECK } from '../../lib/connectors/woocommerce/checks'
import { NW } from '../merchant/helpers'
import { clearConnection } from './helpers'

const ready = await prepareDb()
const SITE = 'https://woo-connect-test-hooks.com'
const CK = 'ck_' + '3'.repeat(40), CS = 'cs_' + '4'.repeat(40)
let store: WooSynthState
let connId = ''
const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL
const secret = () => store.webhooks[0].secret

function delivery(body: unknown, opts: { topic?: string; id?: string; sig?: string | null; conn?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-wc-webhook-topic': opts.topic ?? 'product.updated', 'x-wc-webhook-delivery-id': opts.id ?? `d-${Math.random().toString(36).slice(2)}`, 'x-wc-webhook-source': `${SITE}/` }
  const sig = opts.sig === undefined ? webhookSignature(raw, secret()) : opts.sig
  if (sig !== null) headers['x-wc-webhook-signature'] = sig
  return new Request(`https://app.deploi-test.com/api/woocommerce/webhooks?c=${opts.conn ?? connId}`, { method: 'POST', headers, body: raw })
}
let pending: Promise<void>[] = []
const defer = (fn: () => Promise<void>) => { pending.push(fn()) }
const settle = async () => { await Promise.all(pending); pending = [] }
const receipts = () => admin(db => db.query<{ status: string; note: string }>(`select status, note from webhook_receipts where connection_id = $1 order by received_at`, [connId]))

async function wipe() {
  const ids = await admin(db => db.query<{ id: string }>(`select id from store_connections where external_id = $1`, [SITE]))
  for (const { id } of ids) await clearConnection(id)
  await admin(db => db.query(`delete from store_connections where external_id = $1`, [SITE]))
}

beforeAll(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.deploi-test.com' })
beforeEach(async () => {
  if (!ready) return
  await wipe()
  store = wooDemoState({ siteUrl: SITE, keys: [{ consumerKey: CK, consumerSecret: CS, permissions: 'read_write' }] })
  setWooTransportOverride(() => fakeWooTransport(store))
  connId = (await connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: { consumerKey: CK, consumerSecret: CS }, permissions: 'read_write', via: 'manual' }, { transport: fakeWooTransport(store) })).connectionId
})
afterAll(async () => { setWooTransportOverride(null); process.env.NEXT_PUBLIC_APP_URL = prevAppUrl; if (ready) await wipe() })

describe.skipIf(!ready)('WooCommerce webhooks', () => {
  it('a valid signed delivery triggers a targeted rescan of the product', async () => {
    const res = await handleWooWebhook(delivery({ id: 102, parent_id: 0, name: 'Linen Apron' }), defer)
    expect(res.status).toBe(200)
    await settle()
    expect(await receipts()).toEqual([{ status: 'processed', note: 'targeted rescan of 1 product(s)' }])
    const issue = await admin(db => db.one<{ check_key: string }>(`select check_key from issues where connection_id = $1 and resource_id = 'product:102' and status = 'open'`, [connId]))
    expect(issue?.check_key).toBe(WOO_OVERSOLD_CHECK)
    const scan = await admin(db => db.one<{ scope: string; trigger: string }>(`select scope, trigger from scans where connection_id = $1 order by started_at desc limit 1`, [connId]))
    expect(scan).toEqual({ scope: 'targeted', trigger: 'webhook' })
  })

  it('rejects a missing, wrong or re-computed-with-another-secret signature, and a body changed after signing', async () => {
    const body = JSON.stringify({ id: 102 })
    expect((await handleWooWebhook(delivery(body, { sig: null }), defer)).status).toBe(401)
    expect((await handleWooWebhook(delivery(body, { sig: webhookSignature(body, 'not-the-secret') }), defer)).status).toBe(401)
    const tampered = new Request(delivery(body).url, { method: 'POST', headers: delivery(body).headers, body: JSON.stringify({ id: 101 }) })
    expect((await handleWooWebhook(tampered, defer)).status).toBe(401)
    expect((await handleWooWebhook(delivery(body, { sig: 'x'.repeat(44) }), defer)).status).toBe(401)
    expect(await receipts()).toEqual([])
  })

  it('a replayed delivery id is acknowledged once and not processed again', async () => {
    const first = await handleWooWebhook(delivery({ id: 101 }, { id: 'delivery-1' }), defer)
    expect(first.status).toBe(200)
    await settle()
    const again = await handleWooWebhook(delivery({ id: 101 }, { id: 'delivery-1' }), defer)
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    expect(pending).toHaveLength(0)
    expect(await receipts()).toHaveLength(1)
  })

  it('the unsigned creation ping is acknowledged and ignored', async () => {
    const ping = new Request(`https://app.deploi-test.com/api/woocommerce/webhooks?c=${connId}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'webhook_id=9001' })
    const r = await handleWooWebhook(ping, defer)
    expect(await r.json()).toEqual({ ok: true, ping: true })
    expect(await receipts()).toEqual([])
  })

  it("a delivery signed with one connection's secret is refused for another connection, or an unknown one", async () => {
    const other = '00000000-0000-4000-8000-000000000001'
    expect((await handleWooWebhook(delivery({ id: 101 }, { conn: other }), defer)).status).toBe(401)
    expect((await handleWooWebhook(delivery({ id: 101 }, { conn: 'not-a-uuid' }), defer)).status).toBe(404)
  })

  it('order.created re-reads the ordered products; product.deleted closes their issues', async () => {
    await handleWooWebhook(delivery({ id: 102 }), defer)
    await settle()
    await handleWooWebhook(delivery({ id: 5000, line_items: [{ product_id: 110, variation_id: 111 }, { product_id: 101 }] }, { topic: 'order.created' }), defer)
    await settle()
    expect((await receipts()).pop()).toEqual({ status: 'processed', note: 'targeted rescan of 2 product(s)' })
    await handleWooWebhook(delivery({ id: 102 }, { topic: 'product.deleted' }), defer)
    const closed = await admin(db => db.one<{ status: string; status_reason: string }>(`select status, status_reason from issues where connection_id = $1 and resource_id = 'product:102' order by first_detected_at desc limit 1`, [connId]))
    expect(closed).toEqual({ status: 'resolved', status_reason: 'product deleted in WooCommerce' })
  })

  it('deliveries for a disconnected store are verified, recorded and ignored', async () => {
    await admin(db => db.query(`update store_connections set status = 'disconnected' where id = $1`, [connId]))
    expect((await handleWooWebhook(delivery({ id: 101 }), defer)).status).toBe(200)
    expect(pending).toHaveLength(0)
    expect(await receipts()).toEqual([{ status: 'ignored', note: 'store not connected' }])
  })
})
