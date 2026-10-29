import './env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { fetchActiveSubscription, syncSubscription } from '../../lib/connectors/shopify/billing'
import { exchangeAuthorizationCode, exchangeSessionToken } from '../../lib/connectors/shopify/auth'
import { currentAccessToken } from '../../lib/connectors/shopify/client'
import { storeCredential, loadCredential } from '../../lib/connectors/credentials'
import { loadConnection } from '../../lib/engine/scan'
import { GET as listIssuesRoute } from '../../app/api/store/issues/route'
import { frameAncestors } from '../../middleware'
import { appBridgeFirst } from '../../lib/shopify/head'
import { NW, resetMerchant } from './helpers'

const ready = await prepareDb()
const PARTNER_ENV = { SHOPIFY_PARTNER_API_TOKEN: 'prtapi_test_token', SHOPIFY_PARTNER_ID: '1234567', SHOPIFY_PARTNER_APP_ID: '7654321' }

function fakeFetch(respond: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = respond(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('Shopify App Pricing: subscription status from the Partner API', () => {
  beforeEach(() => { Object.assign(process.env, PARTNER_ENV) })
  afterEach(() => { for (const k of Object.keys(PARTNER_ENV)) delete process.env[k] })

  it('asks the Partner API with the app and shop GIDs; null means no active plan', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: { activeSubscription: null } } }))
    expect(await fetchActiveSubscription('gid://shopify/Shop/42', f.fn)).toBeNull()
    expect(f.calls[0].url).toBe('https://partners.shopify.com/1234567/api/2026-10/graphql.json')
    const headers = f.calls[0].init.headers as Record<string, string>
    expect(headers['x-shopify-access-token']).toBe('prtapi_test_token')
    expect(JSON.parse(String(f.calls[0].init.body)).variables).toEqual({ appId: 'gid://shopify/App/7654321', shopId: 'gid://shopify/Shop/42' })
  })

  it('reads the plan handle, trial and billing cycle; errors and bad ids are refused', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: { activeSubscription: { cancelAtEndOfCycle: false, trialEndsAt: null, currentBillingCycle: { endTime: '2026-11-29T00:00:00Z' }, items: [{ handle: 'standard' }] } } } }))
    expect(await fetchActiveSubscription('gid://shopify/Shop/42', f.fn)).toEqual({ planHandle: 'standard', trialEndsAt: null, periodEnd: '2026-11-29T00:00:00Z', cancelAtEndOfCycle: false })
    await expect(fetchActiveSubscription('gid://shopify/Shop/42', fakeFetch(() => ({ status: 200, body: { errors: [{ message: 'Access denied' }] } })).fn)).rejects.toThrow('Access denied')
    await expect(fetchActiveSubscription('gid://shopify/Shop/42', fakeFetch(() => ({ status: 401, body: {} })).fn)).rejects.toThrow('HTTP 401')
    await expect(fetchActiveSubscription('42', f.fn)).rejects.toThrow('invalid shop id')
    delete process.env.SHOPIFY_PARTNER_API_TOKEN
    await expect(fetchActiveSubscription('gid://shopify/Shop/42', f.fn)).rejects.toThrow('not configured')
  })
})

describe('tokens: expiring offline tokens only', () => {
  it('both the token exchange and the authorization-code fallback ask for expiring tokens', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'shpat_x', scope: 'read_products', expires_in: 3600, refresh_token: 'shprt_x', refresh_token_expires_in: 7776000 } }))
    await exchangeSessionToken('demo.myshopify.com', 'id-token', { fetchImpl: f.fn })
    await exchangeAuthorizationCode('demo.myshopify.com', 'code', { fetchImpl: f.fn })
    for (const c of f.calls) expect(JSON.parse(String(c.init.body)).expiring).toBe('1')
  })
})

describe('embedded app shell', () => {
  it('App Bridge is loaded first in <head> by the root layout, only for embedded pages', () => {
    const root = readFileSync('app/layout.tsx', 'utf8')
    const head = root.slice(root.indexOf('<head>'), root.indexOf('</head>'))
    expect(head).toContain('<meta name="shopify-api-key"')
    expect(head).toContain('https://cdn.shopify.com/shopifycloud/app-bridge.js')
    expect(head).not.toMatch(/async|defer/)
    expect(readFileSync('middleware.ts', 'utf8')).toContain("headers.set('x-deploi-embedded', '1')")
    expect(readFileSync('app/shopify/layout.tsx', 'utf8')).not.toContain('app-bridge.js"')
    expect(frameAncestors('/shopify/agents', 'demo.myshopify.com')).toBe('frame-ancestors https://demo.myshopify.com https://admin.shopify.com;')
    expect(frameAncestors('/store', null)).toBe("frame-ancestors 'none';")
  })

  it('moves App Bridge (and its meta) to the start of <head>, after the charset, and leaves other pages alone', () => {
    const html = '<!DOCTYPE html><html><head><meta charSet="utf-8"/><script src="/_next/a.js" async=""></script><meta name="shopify-api-key" content="abc"/><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script></head><body>x</body></html>'
    expect(appBridgeFirst(html)).toBe('<!DOCTYPE html><html><head><meta charSet="utf-8"/><meta name="shopify-api-key" content="abc"/><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><script src="/_next/a.js" async=""></script></head><body>x</body></html>')
    const plain = '<html><head><script src="/_next/a.js"></script></head><body></body></html>'
    expect(appBridgeFirst(plain)).toBe(plain)
  })

  it('shopify.app.toml.example: managed install, minimal scopes, all compliance topics, no sales channel', () => {
    const toml = readFileSync('shopify.app.toml.example', 'utf8')
    expect(toml).not.toMatch(/^\s*use_legacy_install_flow/m)
    expect(toml).toMatch(/embedded = true/)
    expect(toml).toMatch(/compliance_topics = \["customers\/data_request", "customers\/redact", "shop\/redact"\]/)
    expect(toml).toMatch(/"app\/uninstalled"/)
    expect(toml).not.toMatch(/orders|customers"?,? *"?read_customers|read_customers|write_customers|read_orders/)
    expect(toml).toMatch(/api_version = "2026-10"/)
  })
})

describe.skipIf(!ready)('App Store behaviours against the database', () => {
  beforeEach(async () => { await resetMerchant(NW) })
  afterEach(async () => {
    for (const k of Object.keys(PARTNER_ENV)) delete process.env[k]
    await admin(db => db.query(`delete from app_subscriptions where connection_id = $1 and provider = 'shopify_billing'`, [NW.conn]))
    await admin(db => db.query('update store_connections set is_synthetic = true, shop_gid = null where id = $1', [NW.conn]))
  })

  it('a rejected session token gets 401 with the App Bridge retry header', async () => {
    const r = await listIssuesRoute(new Request('http://localhost/api/store/issues', { headers: { authorization: 'Bearer forged.token.value' } }))
    expect(r.status).toBe(401)
    expect(r.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1')
  })

  it('syncSubscription records the App Pricing plan, caches a confirmed plan, and records a cancellation', async () => {
    Object.assign(process.env, PARTNER_ENV)
    await admin(db => db.query(`update store_connections set is_synthetic = false, shop_gid = 'gid://shopify/Shop/9001' where id = $1`, [NW.conn]))
    const conn = { id: NW.conn, org_id: NW.org, external_id: NW.domain, shop_gid: 'gid://shopify/Shop/9001', is_synthetic: false }
    let plan: unknown = { cancelAtEndOfCycle: false, trialEndsAt: null, currentBillingCycle: { endTime: '2026-11-29T00:00:00Z' }, items: [{ handle: 'standard' }] }
    const f = fakeFetch(() => ({ status: 200, body: { data: { activeSubscription: plan } } }))
    expect(await admin(db => syncSubscription(db, conn, { fetchImpl: f.fn }))).toEqual({ active: true, planHandle: 'standard', checked: true })
    expect(await admin(db => syncSubscription(db, conn, { fetchImpl: f.fn }))).toMatchObject({ active: true, checked: false })
    expect(f.calls.length).toBe(1)
    plan = null
    expect(await admin(db => syncSubscription(db, conn, { fetchImpl: f.fn, force: true }))).toEqual({ active: false, planHandle: null, checked: true })
    const row = await admin(db => db.one<{ status: string; plan_key: string }>(`select status, plan_key from app_subscriptions where provider = 'shopify_billing' and external_id = $1`, [`app_pricing:${NW.domain}`]))
    expect(row).toEqual({ status: 'cancelled', plan_key: 'standard' })
  })

  it('a refused refresh token removes the stored credential so the next app open re-runs token exchange', async () => {
    await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    await admin(db => storeCredential(db, { connectionId: NW.conn, orgId: NW.org, secret: 'shpat_old', tokenKind: 'offline', scopes: ['read_products'], expiresAt: new Date(Date.now() - 1000), refreshSecret: 'shprt_dead', refreshExpiresAt: new Date(Date.now() + 86400e3), actor: 'test' }))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_request' }), { status: 401 })) as typeof fetch
    try {
      await expect(currentAccessToken(conn)).rejects.toThrow('open Deploi from the Shopify admin')
    } finally { globalThis.fetch = realFetch }
    expect(await admin(db => loadCredential(db, NW.conn))).toBeNull()
  })
})
