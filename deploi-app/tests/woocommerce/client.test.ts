/**
 * The real WooCommerce client against a fake HTTP layer (no network, no database): request shapes,
 * Basic auth, pagination, bounded retries for reads only, error classification, address checks
 * (SSRF) and webhook signatures.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { wooRequest, wooPages, wooClientHooks, validCreds, decodeCreds, encodeCreds, buildUrl, WooApiError, type WooSite } from '../../lib/connectors/woocommerce/client'
import { fakeWooTransport, type WooSynthState } from '../../lib/connectors/woocommerce/synthetic'
import { wooDemoState } from '../../lib/connectors/woocommerce/demo-store'
import { realWooTransport, WooRequestRefused, type WooHttpRequest, type WooTransport } from '../../lib/connectors/woocommerce/http'
import { normalizeSiteUrl } from '../../lib/connectors/woocommerce/url'
import { verifyWooSignature, webhookSignature, wooTargetIds } from '../../lib/connectors/woocommerce/webhooks'
import { assertApprovedHost } from '../../lib/net/outbound'
import { probeStore, versionAtLeast } from '../../lib/connectors/woocommerce/connect'

const CK = 'ck_' + 'a'.repeat(40)
const CS = 'cs_' + 'b'.repeat(40)
const SITE = 'https://woo-shop.com'

let slept: number[] = []
const realSleep = wooClientHooks.sleep
beforeAll(() => { wooClientHooks.sleep = async ms => { slept.push(ms) } })
afterAll(() => { wooClientHooks.sleep = realSleep })

function fixture(over: Partial<WooSynthState> = {}): WooSynthState {
  return { ...wooDemoState({ siteUrl: SITE, keys: [{ consumerKey: CK, consumerSecret: CS, permissions: 'read_write' }] }), ...over }
}
function siteOn(state: WooSynthState, spy?: WooHttpRequest[]): WooSite {
  const t = fakeWooTransport(state)
  return { siteUrl: SITE, creds: { consumerKey: CK, consumerSecret: CS }, authMode: 'basic', transport: async r => { spy?.push(r); return t(r) } }
}

describe('request shape', () => {
  it('uses /wp-json/wc/v3, HTTP Basic over https, JSON bodies, and never puts the key in the URL', async () => {
    const seen: WooHttpRequest[] = []
    const s = fixture()
    await wooRequest(siteOn(s, seen), { path: '/products/101' })
    await wooRequest(siteOn(s, seen), { method: 'PUT', path: '/products/101', body: { backorders: 'no' } })
    expect(seen[0].url).toBe(`${SITE}/wp-json/wc/v3/products/101`)
    expect(seen[0].headers.authorization).toBe(`Basic ${Buffer.from(`${CK}:${CS}`).toString('base64')}`)
    expect(seen[0].url).not.toContain('consumer')
    expect(seen[1]).toMatchObject({ method: 'PUT', body: '{"backorders":"no"}' })
    expect(seen[1].headers['content-type']).toBe('application/json')
    expect(s.products.find(p => p.id === 101)!.backorders).toBe('no')
  })
  it('query-string auth mode is available for hosts that strip the Authorization header', async () => {
    const seen: WooHttpRequest[] = []
    await wooRequest({ ...siteOn(fixture(), seen), authMode: 'query' }, { path: '/system_status' })
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(new URL(seen[0].url).searchParams.get('consumer_key')).toBe(CK)
  })
  it('keeps a sub-directory install in the path', () => {
    expect(buildUrl('https://example-shop.com/store', '/products', { per_page: 100 })).toBe('https://example-shop.com/store/wp-json/wc/v3/products?per_page=100')
    expect(buildUrl(SITE, '/wp-json/')).toBe(`${SITE}/wp-json/`)
  })
  it('key pairs are validated before use and round-trip through the stored form', () => {
    expect(validCreds({ consumerKey: CK, consumerSecret: CS })).toBe(true)
    expect(validCreds({ consumerKey: 'ck_short', consumerSecret: CS })).toBe(false)
    expect(validCreds({ consumerKey: CK + '\r\nX: y', consumerSecret: CS })).toBe(false)
    expect(decodeCreds(encodeCreds({ consumerKey: CK, consumerSecret: CS }))).toEqual({ consumerKey: CK, consumerSecret: CS })
    expect(decodeCreds('not json')).toBeNull()
  })
})

describe('pagination', () => {
  it('reads every page with per_page=100 until X-WP-TotalPages', async () => {
    const s = fixture()
    s.products = Array.from({ length: 230 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, slug: `p${i + 1}`, type: 'simple' as const, status: 'publish' as const, sku: `S${i + 1}`, regular_price: '1.00', sale_price: '', manage_stock: false, stock_quantity: null, backorders: 'no' as const, tags: [] }))
    const seen: WooHttpRequest[] = []
    const pages: number[] = []
    for await (const p of wooPages<{ id: number }>(siteOn(s, seen), '/products', { status: 'any' })) pages.push(p.length)
    expect(pages).toEqual([100, 100, 30])
    expect(seen.map(r => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(seen.every(r => new URL(r.url).searchParams.get('per_page') === '100')).toBe(true)
  })
})

describe('retries and error classification', () => {
  it('a read retries 5xx, 429 and resets with backoff, within a bound', async () => {
    slept = []
    const s = fixture({ faults: [{ op: 'GET /products/:id', mode: 'http_500', remaining: 1 }, { op: 'GET /products/:id', mode: 'http_429', remaining: 1 }, { op: 'GET /products/:id', mode: 'network', remaining: 1 }] })
    const r = await wooRequest<{ id: number }>(siteOn(s), { path: '/products/101' })
    expect(r.data.id).toBe(101)
    expect(slept).toHaveLength(3)
    const s2 = fixture({ faults: [{ op: 'GET /products/:id', mode: 'http_500', remaining: 10 }] })
    await expect(wooRequest(siteOn(s2), { path: '/products/101' })).rejects.toMatchObject({ kind: 'unknown', status: 500 })
    expect(s2.faults[0].remaining).toBe(6) // 4 attempts, then stop
  })
  it('a write is sent exactly once: a lost answer is unknown, a 5xx is unknown, a refusal is rejected', async () => {
    const s = fixture({ faults: [{ op: 'PUT /products/:id', mode: 'lost_response_applied', remaining: 1 }] })
    const seen: WooHttpRequest[] = []
    await expect(wooRequest(siteOn(s, seen), { method: 'PUT', path: '/products/101', body: { backorders: 'no' } })).rejects.toMatchObject({ kind: 'unknown' })
    expect(seen).toHaveLength(1)
    expect(s.writeLog).toHaveLength(1)
    const s2 = fixture({ faults: [{ op: 'PUT /products/:id', mode: 'http_500', remaining: 5 }] })
    await expect(wooRequest(siteOn(s2), { method: 'PUT', path: '/products/101', body: { backorders: 'no' } })).rejects.toMatchObject({ kind: 'unknown', status: 500 })
    expect(s2.faults[0].remaining).toBe(4)
    await expect(wooRequest(siteOn(fixture()), { method: 'PUT', path: '/products/101', body: { backorders: 'maybe' } })).rejects.toMatchObject({ kind: 'rejected', status: 400, code: 'rest_invalid_param' })
  })
  it('auth, not found and duplicate SKU are definite answers', async () => {
    const wrong: WooSite = { ...siteOn(fixture()), creds: { consumerKey: 'ck_' + 'c'.repeat(40), consumerSecret: CS } }
    await expect(wooRequest(wrong, { path: '/products/101' })).rejects.toMatchObject({ kind: 'auth', status: 401 })
    const readOnly = fixture({ keys: [{ consumerKey: CK, consumerSecret: CS, permissions: 'read' }] })
    await expect(wooRequest(siteOn(readOnly), { method: 'PUT', path: '/products/101', body: { backorders: 'no' } })).rejects.toMatchObject({ kind: 'auth' })
    await expect(wooRequest(siteOn(fixture()), { path: '/products/999' })).rejects.toMatchObject({ kind: 'not_found', code: 'woocommerce_rest_product_invalid_id' })
    await expect(wooRequest(siteOn(fixture()), { method: 'PUT', path: '/products/105', body: { sku: 'NW-OCB' } })).rejects.toMatchObject({ kind: 'rejected', code: 'product_invalid_sku' })
  })
  it('a 200 that is not JSON (not a WooCommerce REST API) is not trusted', async () => {
    const t: WooTransport = async () => ({ status: 200, headers: {}, body: '<html>hello</html>' })
    await expect(wooRequest({ ...siteOn(fixture()), transport: t }, { path: '/products' })).rejects.toBeInstanceOf(WooApiError)
  })
  it('a redirect is reported, never followed with the key attached', async () => {
    const t: WooTransport = async () => ({ status: 301, headers: { location: 'https://elsewhere.com/' }, body: '' })
    await expect(wooRequest({ ...siteOn(fixture()), transport: t }, { path: '/products' })).rejects.toMatchObject({ kind: 'rejected', status: 301 })
  })
})

describe('store address and SSRF', () => {
  it('normalises to an https origin (plus a sub-directory) and refuses unsafe addresses', () => {
    expect(normalizeSiteUrl('Shop.Example-Store.com/')).toEqual({ ok: true, siteUrl: 'https://shop.example-store.com', host: 'shop.example-store.com' })
    expect(normalizeSiteUrl('https://example-store.com/blog/wp-admin/')).toMatchObject({ ok: true, siteUrl: 'https://example-store.com/blog' })
    for (const bad of ['http://shop.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://shop.local', 'https://intranet', 'https://user:pw@shop.com', 'https://shop.com:8443', 'ftp://shop.com', 'https://shop.internal', '', 'https://shop.com/a b/<script>'])
      expect(normalizeSiteUrl(bad).ok, bad).toBe(false)
    expect(normalizeSiteUrl('https://shop.com/?utm=x#top')).toMatchObject({ ok: true, siteUrl: 'https://shop.com' })
  })
  it('the transport refuses hosts that resolve to private addresses, before connecting', async () => {
    let connected = 0
    const connect = async () => { connected++; return { status: 200, headers: {}, body: '{}' } }
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.10', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      const t = realWooTransport('woo-shop.com', { resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }], connect })
      await expect(t({ method: 'GET', url: `${SITE}/wp-json/wc/v3/products`, headers: {} }), address).rejects.toBeInstanceOf(WooRequestRefused)
    }
    expect(connected).toBe(0)
  })
  it('the transport only reaches the connection’s own host, over https, and connects to the checked address', async () => {
    const seen: { address: string }[] = []
    const connect = async (r: { address: string }) => { seen.push(r); return { status: 200, headers: {}, body: '{}' } }
    const t = realWooTransport('woo-shop.com', { resolve: async () => [{ address: '93.184.216.34', family: 4 }], connect })
    await t({ method: 'GET', url: `${SITE}/wp-json/wc/v3/products`, headers: {} })
    expect(seen[0].address).toBe('93.184.216.34')
    await expect(t({ method: 'GET', url: 'https://other-shop.com/wp-json/wc/v3/products', headers: {} })).rejects.toBeInstanceOf(WooRequestRefused)
    await expect(t({ method: 'GET', url: 'http://woo-shop.com/wp-json/wc/v3/products', headers: {} })).rejects.toBeInstanceOf(WooRequestRefused)
    expect(() => assertApprovedHost('https://10.0.0.1/x', 'woocommerce')).toThrow()
    expect(() => assertApprovedHost('https://api.resend.com/x', 'woocommerce')).toThrow()
    expect(assertApprovedHost(`${SITE}/x`, 'woocommerce')).toBe('woo-shop.com')
  })
  it('a refused address becomes a definite client error, never an unknown that would be retried', async () => {
    const t = realWooTransport('woo-shop.com', { resolve: async () => [{ address: '10.1.1.1', family: 4 }], connect: async () => { throw new Error('must not connect') } })
    await expect(wooRequest({ ...siteOn(fixture()), transport: t }, { path: '/products' })).rejects.toMatchObject({ kind: 'rejected' })
  })
})

describe('probe', () => {
  it('reads the WooCommerce version, currency and name with the key; refuses old versions and bad keys', async () => {
    const f = await probeStore(SITE, { consumerKey: CK, consumerSecret: CS }, { transport: fakeWooTransport(fixture()) })
    expect(f).toMatchObject({ wcVersion: '11.2.1', currency: 'USD', name: 'Northwind Woo (synthetic)', authMode: 'basic' })
    const old = fixture(); old.site.wcVersion = '3.4.9'
    await expect(probeStore(SITE, { consumerKey: CK, consumerSecret: CS }, { transport: fakeWooTransport(old) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(probeStore(SITE, { consumerKey: 'ck_' + 'd'.repeat(40), consumerSecret: CS }, { transport: fakeWooTransport(fixture()) })).rejects.toThrow(/refused the key/)
    expect(versionAtLeast('10.0', '3.5.0')).toBe(true)
    expect(versionAtLeast('3.5.0', '3.5.0')).toBe(true)
  })
})

describe('webhook signatures and targets', () => {
  it('base64 HMAC-SHA256 of the raw body, compared in constant time', () => {
    const body = '{"id":101}'
    const sig = webhookSignature(body, 'secret-1')
    expect(sig).toBe(require('node:crypto').createHmac('sha256', 'secret-1').update(body).digest('base64'))
    expect(verifyWooSignature(body, sig, 'secret-1')).toBe(true)
    expect(verifyWooSignature(body + ' ', sig, 'secret-1')).toBe(false)
    expect(verifyWooSignature(body, sig, 'secret-2')).toBe(false)
    expect(verifyWooSignature(body, null, 'secret-1')).toBe(false)
    expect(verifyWooSignature(body, sig, '')).toBe(false)
  })
  it('product and order deliveries map to the products to re-read', () => {
    expect(wooTargetIds('product.updated', { id: 111, parent_id: 110 })).toEqual(['product:110'])
    expect(wooTargetIds('product.updated', { id: 101, parent_id: 0 })).toEqual(['product:101'])
    expect(wooTargetIds('order.created', { line_items: [{ product_id: 101, variation_id: 0 }, { product_id: 110, variation_id: 111 }, { product_id: 101 }] })).toEqual(['product:101', 'product:110'])
    expect(wooTargetIds('coupon.created', { id: 1 })).toEqual([])
  })
})
