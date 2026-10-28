import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyQueryHmac, verifyWebhookHmac, verifySessionToken, signSessionToken, normalizeShop, exchangeSessionToken } from '../../lib/connectors/shopify/auth'
import { realTransport } from '../../lib/connectors/shopify/client'

const KEY = 'test-api-key', SECRET = 'test-api-secret-0123456789'
const SHOP = 'example-shop.myshopify.com'

describe('Shopify authentication primitives', () => {
  it('normalises and validates shop domains', () => {
    expect(normalizeShop('Example-Shop')).toBe(SHOP)
    expect(normalizeShop('https://example-shop.myshopify.com/admin')).toBe(SHOP)
    expect(normalizeShop('evil.com')).toBeNull()
    expect(normalizeShop('example-shop.myshopify.com.evil.com')).toBeNull()
  })

  it('verifies OAuth query HMACs (sorted, hmac removed) and rejects tampering', () => {
    const params: Record<string, string> = { shop: SHOP, code: 'abc', state: 'xyz', timestamp: '1761650000' }
    const msg = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
    const hmac = createHmac('sha256', SECRET).update(msg).digest('hex')
    expect(verifyQueryHmac({ ...params, hmac }, SECRET)).toBe(true)
    expect(verifyQueryHmac({ ...params, code: 'other', hmac }, SECRET)).toBe(false)
    expect(verifyQueryHmac(params, SECRET)).toBe(false)
  })

  it('verifies webhook HMACs over the raw body', () => {
    const body = '{"id":1}'
    const sig = createHmac('sha256', SECRET).update(body).digest('base64')
    expect(verifyWebhookHmac(body, sig, SECRET)).toBe(true)
    expect(verifyWebhookHmac(body + ' ', sig, SECRET)).toBe(false)
    expect(verifyWebhookHmac(body, null, SECRET)).toBe(false)
  })

  it('accepts a valid session token and rejects expired, forged, wrong-audience, wrong-shop and alg tricks', () => {
    const now = new Date('2026-10-28T12:00:00Z')
    const ok = signSessionToken({ dest: `https://${SHOP}`, sub: '42' }, SECRET, KEY, now)
    expect(verifySessionToken(ok, { apiKey: KEY, apiSecret: SECRET, now })).toMatchObject({ shop: SHOP, userId: '42' })
    expect(() => verifySessionToken(ok, { apiKey: KEY, apiSecret: SECRET, now: new Date(now.getTime() + 120_000) })).toThrow(/expired/)
    expect(() => verifySessionToken(ok, { apiKey: KEY, apiSecret: 'wrong', now })).toThrow(/signature/)
    expect(() => verifySessionToken(ok, { apiKey: 'other-app', apiSecret: SECRET, now })).toThrow(/audience/)
    const mismatch = signSessionToken({ dest: `https://${SHOP}`, iss: 'https://other-shop.myshopify.com/admin' }, SECRET, KEY, now)
    expect(() => verifySessionToken(mismatch, { apiKey: KEY, apiSecret: SECRET, now })).toThrow(/shop mismatch/)
    const [, p] = ok.split('.')
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${p}.`
    expect(() => verifySessionToken(none, { apiKey: KEY, apiSecret: SECRET, now })).toThrow()
    const notYet = signSessionToken({ dest: `https://${SHOP}`, nbf: Math.floor(now.getTime() / 1000) + 300 }, SECRET, KEY, now)
    expect(() => verifySessionToken(notYet, { apiKey: KEY, apiSecret: SECRET, now })).toThrow(/not yet valid/)
  })

  it('token exchange requests an expiring offline token and only talks to the shop domain', async () => {
    let seen: { url: string; body: Record<string, string> } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ access_token: 'shpat_test', scope: 'read_products,write_products', expires_in: 3600, refresh_token: 'shprt_test', refresh_token_expires_in: 7776000 }), { status: 200 })
    }) as unknown as typeof fetch
    const t = await exchangeSessionToken(SHOP, 'id-token', { fetchImpl })
    expect(seen!.url).toBe(`https://${SHOP}/admin/oauth/access_token`)
    expect(seen!.body).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token', expiring: '1' })
    expect(t).toMatchObject({ accessToken: 'shpat_test', expiresIn: 3600, refreshToken: 'shprt_test', scope: ['read_products', 'write_products'] })
    expect(() => realTransport('evil.example.com', 'x')).toThrow(/not approved/)
  })
})
