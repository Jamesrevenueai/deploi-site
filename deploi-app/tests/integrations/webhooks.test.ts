/**
 * Webhook management and diagnostics: Shopify shop-level subscriptions read and re-created with
 * webhookSubscriptionCreate, WooCommerce REST webhooks verified live and re-registered, QuickBooks (set up
 * once in the Intuit portal) and Stripe (read-only, staff) described honestly; the diagnostics drawer
 * shows token expiry, rate-limit headroom and recent checks without any secret.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { reregisterWebhooks, webhookState, setWebhookStripeFetch, SHOPIFY_TOPICS } from '../../lib/integrations/webhooks'
import { diagnostics, staffOverview } from '../../lib/integrations/diagnostics'
import { testIntegration } from '../../lib/integrations/registry'
import { setTransportOverride, resetThrottleState, type GqlBody } from '../../lib/connectors/shopify/client'
import { setWooTransportOverride } from '../../lib/connectors/woocommerce/client'
import { deliveryUrl } from '../../lib/connectors/woocommerce/webhooks'
import { merchantActor, staffActor } from '../merchant/helpers'
import { HB, NW, realStore, cleanIntegrations, fakeFetch, json } from './helpers'

const ready = await prepareDb()
const ENV = { SHOPIFY_APP_URL: 'https://app.deploi.test', NEXT_PUBLIC_APP_URL: 'https://app.deploi.test', STRIPE_SECRET_KEY: 'sk_test_hooks' }
let saved: Record<string, string | undefined> = {}

describe.skipIf(!ready)('webhook management and diagnostics', () => {
  beforeEach(async () => { await cleanIntegrations(); saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]])); Object.assign(process.env, ENV) })
  afterEach(() => { setTransportOverride(null); setWooTransportOverride(null); setWebhookStripeFetch(null); resetThrottleState(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  afterAll(async () => { if (ready) await cleanIntegrations() })

  it('Shopify: reads the shop-level subscriptions and creates the missing topics with webhookSubscriptionCreate', async () => {
    const id = await realStore(HB.org, 'shopify', 'probe-hooks.myshopify.com')
    const url = 'https://app.deploi.test/api/shopify/webhooks'
    const subs = [{ id: 'gid://shopify/WebhookSubscription/1', topic: 'APP_UNINSTALLED', uri: url }, { id: 'gid://shopify/WebhookSubscription/2', topic: 'PRODUCTS_UPDATE', uri: url }, { id: 'gid://shopify/WebhookSubscription/3', topic: 'ORDERS_CREATE', uri: 'https://elsewhere.example/hook' }]
    const sent: GqlBody[] = []
    setTransportOverride(() => async body => {
      sent.push(body)
      if (body.operationName === 'DeploiWebhookSubscriptions') return { status: 200, json: { data: { webhookSubscriptions: { nodes: subs } } } }
      if (body.operationName === 'DeploiWebhookSubscriptionCreate') {
        const v = body.variables as { topic: string; webhookSubscription: { uri: string; format: string } }
        if (v.topic === 'INVENTORY_ITEMS_UPDATE') return { status: 200, json: { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['webhookSubscription'], message: 'Address for this topic has already been taken' }] } } } }
        subs.push({ id: `gid://shopify/WebhookSubscription/${subs.length + 1}`, topic: v.topic, uri: v.webhookSubscription.uri })
        return { status: 200, json: { data: { webhookSubscriptionCreate: { webhookSubscription: subs.at(-1), userErrors: [] } } } }
      }
      return { status: 200, json: { errors: [{ message: 'unexpected operation' }] } }
    })
    const before = (await webhookState('shopify', id))!
    expect(before.topics.filter(t => t.registered).map(t => t.topic)).toEqual(['APP_UNINSTALLED', 'PRODUCTS_UPDATE'])
    expect(before).toMatchObject({ support: 'reregister', canReregister: true })
    const r = await reregisterWebhooks(await merchantActor(HB), 'shopify', id)
    expect(r).toMatchObject({ created: 4, existing: 2 })
    expect(r.errors).toEqual(['INVENTORY_ITEMS_UPDATE: Address for this topic has already been taken'])
    const creates = sent.filter(b => b.operationName === 'DeploiWebhookSubscriptionCreate')
    expect(creates.map(b => (b.variables as { topic: string }).topic)).toEqual(SHOPIFY_TOPICS.filter(t => t !== 'APP_UNINSTALLED' && t !== 'PRODUCTS_UPDATE'))
    expect(creates[0].variables).toMatchObject({ webhookSubscription: { uri: url, format: 'JSON' } })
    expect(creates[0].query).toMatch(/webhookSubscriptionCreate\(topic: \$topic, webhookSubscription: \$webhookSubscription\)/)
    expect((await webhookState('shopify', id))!.topics.filter(t => t.registered)).toHaveLength(6)
    await expect(reregisterWebhooks(await staffActor(), 'shopify', id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(reregisterWebhooks(await merchantActor(NW), 'shopify', id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('WooCommerce: verifies Deploi\'s webhooks live and re-registers them (new secret, same connection)', async () => {
    const id = await realStore(HB.org, 'woocommerce', 'https://hooks-probe.store')
    const hookUrl = deliveryUrl(id)
    let hooks = [{ id: 11, topic: 'product.updated', status: 'active', delivery_url: hookUrl }, { id: 12, topic: 'product.deleted', status: 'paused', delivery_url: hookUrl }]
    const log: string[] = []
    setWooTransportOverride(() => async (req): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      const u = new URL(req.url)
      log.push(`${req.method} ${u.pathname}`)
      if (req.method === 'GET' && u.pathname.endsWith('/webhooks')) return { status: 200, headers: { 'x-wp-totalpages': '1' }, body: JSON.stringify(hooks) }
      if (req.method === 'DELETE') { hooks = hooks.filter(h => !u.pathname.endsWith(`/${h.id}`)); return { status: 200, headers: {}, body: '{}' } }
      if (req.method === 'POST' && u.pathname.endsWith('/webhooks')) { const b = JSON.parse(req.body!); const h = { id: 20 + hooks.length, topic: b.topic, status: 'active', delivery_url: b.delivery_url }; hooks.push(h); return { status: 201, headers: {}, body: JSON.stringify({ ...h, secret: b.secret }) } }
      return { status: 404, headers: {}, body: JSON.stringify({ code: 'rest_no_route' }) }
    })
    const d = await diagnostics(HB.org, 'woocommerce')
    expect(d.connections[0].webhooks).toMatchObject({ summary: '1 of 3 webhooks are registered and active on the store.', topics: [{ topic: 'product.updated', registered: true }, { topic: 'product.deleted', registered: false }, { topic: 'order.created', registered: false }] })
    expect(d.connections[0].token).toMatchObject({ kind: 'api_key_pair', stored: true })
    expect(JSON.stringify(d)).not.toMatch(/ck_|cs_|secret/)
    const r = await reregisterWebhooks(await merchantActor(HB), 'woocommerce', id)
    expect(r).toMatchObject({ created: 3, errors: [] })
    expect(log.filter(l => l.startsWith('DELETE')).length).toBe(3) // 11, 12 and 13 recorded at connect
    expect((await webhookState('woocommerce', id))!.topics.every(t => t.registered)).toBe(true)
  })

  it('QuickBooks is set up once in the Intuit portal; Stripe endpoints are read-only and shown to staff only', async () => {
    const savedV = process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN
    delete process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN
    expect(await webhookState('quickbooks', null)).toMatchObject({ support: 'portal', canReregister: false, summary: expect.stringMatching(/not set up on this deployment/) })
    process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = 'verifier'
    expect((await webhookState('quickbooks', null))!.summary).toMatch(/one webhook set up for the Deploi app/)
    if (savedV === undefined) delete process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN; else process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = savedV
    const f = fakeFetch(() => json(200, { object: 'list', data: [{ id: 'we_1', url: 'https://app.deploi.test/api/billing/stripe/webhook', status: 'enabled', enabled_events: ['customer.subscription.updated', 'invoice.paid'] }, { id: 'we_2', url: 'https://other.example/x', status: 'enabled', enabled_events: ['*'] }] }))
    setWebhookStripeFetch(f.fetch)
    expect(await webhookState('stripe', null, { staff: true })).toMatchObject({ support: 'readonly', canReregister: false, summary: '1 Stripe endpoint point at Deploi (1 enabled).', topics: [{ topic: 'customer.subscription.updated' }, { topic: 'invoice.paid' }] })
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/webhook_endpoints?limit=20' })
    expect(await webhookState('stripe', null, { staff: false })).toMatchObject({ summary: 'Billing events are managed by Deploi.', topics: [] })
    expect(f.calls).toHaveLength(1)
  })

  it('diagnostics: recent checks, error codes, headroom and token expiry, never a token; staff overview spans organizations', async () => {
    const id = await realStore(HB.org, 'shopify', 'probe-diag.myshopify.com')
    let fail = false
    setTransportOverride(() => async body => body.operationName === 'DeploiShop' && !fail
      ? { status: 200, json: { data: { shop: { name: 'Diag' } }, extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 } } } } }
      : { status: 503, json: null })
    await testIntegration(HB.org, 'shopify')
    fail = true
    await testIntegration(HB.org, 'shopify')
    const d = await diagnostics(HB.org, 'shopify', { live: false })
    const c = d.connections.find(x => x.connectionId === id)!
    expect(c.recentChecks.map(r => [r.ok, r.code, r.trigger])).toEqual([[false, 'server', 'manual'], [true, null, 'manual']])
    expect(c.errorCodes).toEqual([{ code: 'server', count: 1 }])
    expect(c.rateLimit).toEqual({ rateLimitAvailable: 990, rateLimitMax: 1000, rateLimitRestorePerSecond: 50 })
    expect(c.token).toMatchObject({ kind: 'offline', stored: true })
    expect(JSON.stringify(d)).not.toContain('shpat_test_token')
    const staff = await staffOverview()
    expect(staff.rows.some(r => r.orgId === HB.org && r.key === 'shopify' && r.connections.some(x => x.id === id && x.failures === 1))).toBe(true)
    expect(staff.rows.some(r => r.orgId === NW.org)).toBe(true)
    expect(staff.setup.find(s => s.key === 'stripe')!.missingEnv).toEqual(expect.arrayContaining(['BILLING_MODE']))
  })
})
