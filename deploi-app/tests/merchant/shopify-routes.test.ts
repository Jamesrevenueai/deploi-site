import './env'
import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { runScan } from '../../lib/engine/scan'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { loadCredential } from '../../lib/connectors/credentials'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { mutateSynthetic } from '../../lib/connectors/shopify/synthetic'
import { NW, HB, resetMerchant, store } from './helpers'
import { GET as getIssue } from '../../app/api/store/issues/[id]/route'
import { POST as approve } from '../../app/api/store/proposals/[id]/approve/route'
import { GET as listIssuesRoute } from '../../app/api/store/issues/route'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!

function webhook(topic: string, shop: string, body: unknown, opts: { id?: string; sign?: boolean } = {}) {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = { 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': opts.id ?? `wh-${Math.random().toString(36).slice(2)}`, 'content-type': 'application/json' }
  if (opts.sign !== false) headers['x-shopify-hmac-sha256'] = createHmac('sha256', SECRET).update(raw).digest('base64')
  return new Request('http://localhost/api/shopify/webhooks', { method: 'POST', headers, body: raw })
}
const inline = (fn: () => Promise<void>) => { void fn() }
const bearer = (shop: string) => ({ authorization: `Bearer ${signSessionToken({ dest: `https://${shop}`, sub: '7' }, SECRET, KEY)}` })

describe.skipIf(!ready)('Shopify webhooks, install and the bearer-authenticated API', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB) })

  it('rejects unsigned or forged webhooks with 401, de-duplicates deliveries and answers compliance topics', async () => {
    expect((await handleShopifyWebhook(webhook('customers/redact', NW.domain, { shop_domain: NW.domain }, { sign: false }), inline)).status).toBe(401)
    const forged = webhook('customers/redact', NW.domain, {})
    forged.headers.set('x-shopify-hmac-sha256', createHmac('sha256', 'wrong').update('{}').digest('base64'))
    expect((await handleShopifyWebhook(forged, inline)).status).toBe(401)
    for (const t of ['customers/data_request', 'customers/redact']) expect((await handleShopifyWebhook(webhook(t, NW.domain, { shop_domain: NW.domain }), inline)).status).toBe(200)
    const id = `wh-dup-${Date.now()}`
    expect(await (await handleShopifyWebhook(webhook('customers/data_request', NW.domain, {}, { id }), inline)).json()).toMatchObject({ ok: true })
    expect(await (await handleShopifyWebhook(webhook('customers/data_request', NW.domain, {}, { id }), inline)).json()).toMatchObject({ duplicate: true })
  })

  it('products/update re-reads the product: an outside fix closes the issue and its proposal goes stale', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    await mutateSynthetic(NW.conn, s => { s.products.find(p => p.id === NORTHWIND_IDS.P(1001))!.variants[0].inventoryPolicy = 'DENY' })
    let done: Promise<void> = Promise.resolve()
    const res = await handleShopifyWebhook(webhook('products/update', NW.domain, { admin_graphql_api_id: NORTHWIND_IDS.P(1001) }), fn => { done = fn() })
    expect(res.status).toBe(200)
    await done
    const issue = await admin(db => db.one<{ status: string }>(`select status from issues where connection_id = $1 and resource_id = $2 order by created_at desc limit 1`, [NW.conn, NORTHWIND_IDS.V(2001)]))
    expect(issue!.status).toBe('resolved')
    const p = await admin(db => db.one<{ status: string }>(`select status from proposals where connection_id = $1 and target_id = $2 order by created_at desc limit 1`, [NW.conn, NORTHWIND_IDS.V(2001)]))
    expect(p!.status).toBe('stale')
  })

  it('app/uninstalled stops everything; shop/redact erases the shop and its organization', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    // a disposable installed shop for the destructive part
    const shop = `redact-test-${Date.now()}.myshopify.com`
    const r = await ensureInstalled(shop, 'id-token', {
      exchange: async () => ({ accessToken: 'shpat_redact_test', scope: ['read_products', 'write_products', 'read_inventory'], expiresIn: 3600, refreshToken: 'shprt_redact_test', refreshTokenExpiresIn: 7776000 }),
      info: async () => ({ name: 'Redact Test (synthetic)', timezone: 'UTC' }),
    })
    expect(r).toMatchObject({ created: true, tokenExchanged: true })
    const cred = await admin(db => loadCredential(db, r.connectionId))
    expect(cred).toMatchObject({ secret: 'shpat_redact_test', refreshSecret: 'shprt_redact_test' })
    const again = await ensureInstalled(shop, 'id-token', { exchange: async () => { throw new Error('must not exchange again') } })
    expect(again.tokenExchanged).toBe(false)
    expect((await handleShopifyWebhook(webhook('app/uninstalled', shop, { id: 1 }), inline)).status).toBe(200)
    const c = await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1', [r.connectionId]))
    expect(c!.status).toBe('uninstalled')
    expect(await admin(db => loadCredential(db, r.connectionId))).toBeNull()
    expect((await handleShopifyWebhook(webhook('shop/redact', shop, { shop_domain: shop }), inline)).status).toBe(200)
    expect(await admin(db => db.one('select 1 from store_connections where id = $1', [r.connectionId]))).toBeNull()
    expect(await admin(db => db.one('select 1 from agencies where id = $1', [r.orgId]))).toBeNull()
    // Northwind is untouched
    expect(await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1', [NW.conn]))).toMatchObject({ status: 'active' })
  })

  it('the embedded API authenticates with the Shopify session token and keeps shops apart', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const list = await listIssuesRoute(new Request('http://localhost/api/store/issues', { headers: bearer(NW.domain) }))
    const { issues } = await list.json() as { issues: { id: string; resource_id: string; proposal: { id: string; change_hash: string } | null }[] }
    expect(issues.length).toBe(6)
    const target = issues.find(i => i.resource_id === NORTHWIND_IDS.V(2003))!
    const other = await getIssue(new Request(`http://localhost/api/store/issues/${target.id}`, { headers: bearer(HB.domain) }), { params: Promise.resolve({ id: target.id }) })
    expect(other.status).toBe(404)
    const noToken = await listIssuesRoute(new Request('http://localhost/api/store/issues', { headers: { authorization: 'Bearer forged.token.value' } }))
    expect(noToken.status).toBe(401)
    const badHash = await approve(new Request(`http://localhost/api/store/proposals/${target.proposal!.id}/approve`, { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json' }, body: JSON.stringify({ changeHash: '0'.repeat(64) }) }), { params: Promise.resolve({ id: target.proposal!.id }) })
    expect(badHash.status).toBe(409)
    const ok = await approve(new Request(`http://localhost/api/store/proposals/${target.proposal!.id}/approve`, { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json' }, body: JSON.stringify({ changeHash: target.proposal!.change_hash }) }), { params: Promise.resolve({ id: target.proposal!.id }) })
    expect(await ok.json()).toMatchObject({ ok: true, status: 'verified' })
    const s = await store(NW)
    expect(s!.products.flatMap(p => p.variants).find(v => v.id === NORTHWIND_IDS.V(2003))!.inventoryPolicy).toBe('DENY')
    const approval = await admin(db => db.one<{ approved_by: string; approver_kind: string }>('select approved_by, approver_kind from approvals where proposal_id = $1', [target.proposal!.id]))
    expect(approval).toMatchObject({ approver_kind: 'shopify_user', approved_by: `shopify:${NW.domain}:user:7` })
  })
})
