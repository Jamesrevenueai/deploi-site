/**
 * Shopify App Store requirements that can be checked in code (docs/app-store/SUBMISSION-CHECKLIST.md cites
 * each test here as its evidence).
 */
import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { prepareDb } from '../db/helpers'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES } from '../../lib/connectors/shopify/config'
import { NW, resetMerchant } from '../merchant/helpers'

const ROOT = path.resolve(__dirname, '../..')
const files = (dir: string, name: string): string[] => readdirSync(dir).flatMap(n => { const p = path.join(dir, n); return statSync(p).isDirectory() ? files(p, name) : n === name ? [p] : [] })
const COMPLIANCE = ['customers/data_request', 'customers/redact', 'shop/redact'] as const
/** Shopify's protected customer data: never requested by this app (docs/app-store/PROTECTED-CUSTOMER-DATA.md) */
const PROTECTED = ['read_customers', 'write_customers', 'read_orders', 'write_orders', 'read_all_orders', 'read_draft_orders', 'write_draft_orders', 'read_fulfillments', 'read_returns', 'read_checkouts']

describe('App Store requirements checked in code', () => {
  it('1.1.1 session tokens: every store API route authenticates through resolveActor (App Bridge id token or Deploi session)', () => {
    const routes = files(path.join(ROOT, 'app/api/store'), 'route.ts')
    expect(routes.length).toBeGreaterThan(50)
    const missing = routes.filter(f => !readFileSync(f, 'utf8').includes('resolveActor('))
    expect(missing.map(f => path.relative(ROOT, f))).toEqual([])
  })

  it('3.2 scopes: no protected customer data scope anywhere; the writes the agents use are requested at install and explained in the listing', () => {
    for (const s of [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES]) expect(PROTECTED, s).not.toContain(s)
    // every write requested at install is one a ready agent uses, and the listing explains it to the merchant
    const writes = REQUIRED_SCOPES.filter(s => s.startsWith('write_'))
    expect(writes).toEqual(['write_products'])
    const listing = readFileSync(path.join(ROOT, 'docs/app-store/LISTING.md'), 'utf8')
    for (const s of writes) expect(listing, `LISTING.md explains ${s}`).toContain(s)
    expect(REQUIRED_SCOPES.filter(s => !s.startsWith('read_') && !s.startsWith('write_'))).toEqual([])
    for (const toml of ['shopify.app.toml.example', 'shopify.app.deploi-dev.toml.example']) {
      const t = readFileSync(path.join(ROOT, toml), 'utf8')
      const scopeLines = t.split('\n').filter(l => /^\s*(scopes|optional_scopes)\s*=/.test(l)).join('\n')
      for (const s of PROTECTED) expect(scopeLines, `${toml} ${s}`).not.toContain(s)
    }
  })

  it('4.1 name and URLs: app name at most 30 characters; app URL host without "shopify" or "example"', () => {
    const t = readFileSync(path.join(ROOT, 'shopify.app.toml.example'), 'utf8')
    const name = /^name = "([^"]+)"/m.exec(t)![1]
    expect(name.length).toBeLessThanOrEqual(30)
    const host = new URL(/^application_url = "([^"]+)"/m.exec(t)![1]).host
    expect(host).not.toMatch(/shopify|example/i)
    expect(t).toMatch(/^embedded = true/m)
  })

  it('2.2.3 App Bridge: loaded from Shopify\'s CDN by the root layout (moved first in <head> by middleware)', () => {
    const layout = readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8')
    expect(layout).toContain('https://cdn.shopify.com/shopifycloud/app-bridge.js')
    expect(readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8')).toContain('appBridgeFirst(')
  })
})

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
function webhook(topic: string, shop: string, body: unknown, sign: string | null = SECRET) {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = { 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': `wh-req-${topic}-${Math.random().toString(36).slice(2)}`, 'content-type': 'application/json' }
  if (sign) headers['x-shopify-hmac-sha256'] = createHmac('sha256', sign).update(raw).digest('base64')
  return new Request('http://localhost/api/shopify/webhooks', { method: 'POST', headers, body: raw })
}
const inline = (fn: () => Promise<void>) => { void fn() }

describe.skipIf(!ready)('compliance webhooks: status codes and response time', () => {
  it('each mandatory topic answers 401 to a missing or wrong HMAC', async () => {
    for (const t of COMPLIANCE) {
      expect((await handleShopifyWebhook(webhook(t, NW.domain, { shop_domain: NW.domain }, null), inline)).status, t).toBe(401)
      expect((await handleShopifyWebhook(webhook(t, NW.domain, { shop_domain: NW.domain }, 'not-the-secret'), inline)).status, t).toBe(401)
    }
  })

  it('each mandatory topic answers 200 well inside Shopify\'s 5 second limit, for an installed and a never-installed shop', async () => {
    await resetMerchant(NW)
    const body = { shop_domain: NW.domain, customer: { id: 991, email: 'shopper@customer.example' }, orders_requested: [1], orders_to_redact: [1] }
    for (const shop of [NW.domain, 'never-installed-req.myshopify.com']) {
      // shop/redact for the live demo shop is deferred (it is installed), so it never erases the fixture
      for (const t of COMPLIANCE) {
        const started = Date.now()
        const res = await handleShopifyWebhook(webhook(t, shop, { ...body, shop_domain: shop }), inline)
        const ms = Date.now() - started
        expect(res.status, `${t} ${shop}`).toBe(200)
        expect(ms, `${t} ${shop} took ${ms} ms`).toBeLessThan(2000)
      }
    }
  })
})
