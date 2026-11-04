import '../merchant/env'
import { describe, it, expect, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { currentAccessToken, shopifyGraphql, setTransportOverride, setSleep, throttleWaitMs, pacingWaitMs, resetThrottleState, ShopifyApiError, type Transport } from '../../lib/connectors/shopify/client'
import { loadCredential, storeCredential } from '../../lib/connectors/credentials'
import { loadConnection } from '../../lib/engine/scan'
import { shopifyConnector } from '../../lib/connectors/shopify/connector'
import type { ConnectionRow } from '../../lib/engine/types'
import { NW } from '../merchant/helpers'

const ready = await prepareDb()

type Call = { url: string; body: Record<string, string> }
function tokenEndpoint(responses: (Response | Error)[]) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    const r = responses.shift()
    if (!r) throw new Error('unexpected token request')
    if (r instanceof Error) throw r
    return r
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

async function installed(): Promise<ConnectionRow> {
  const shop = `token-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.myshopify.com`
  const r = await ensureInstalled(shop, 'id-token', {
    exchange: async () => ({ accessToken: 'shpat_first', scope: ['read_products', 'read_inventory', 'read_locations'], expiresIn: 3600, refreshToken: 'shprt_first', refreshTokenExpiresIn: 7776000 }),
    info: async () => ({ name: 'Token Test (synthetic)', timezone: 'UTC' }),
  })
  return (await admin(db => loadConnection(db, r.connectionId)))!
}
const expire = (c: ConnectionRow, over: { refresh?: string | null; refreshExpiresAt?: Date | null } = {}) => admin(db => storeCredential(db, {
  connectionId: c.id, orgId: c.org_id, secret: 'shpat_old', scopes: c.scopes, expiresAt: new Date(Date.now() - 1000),
  refreshSecret: over.refresh === undefined ? 'shprt_old' : over.refresh, refreshExpiresAt: over.refreshExpiresAt === undefined ? new Date(Date.now() + 864e5 * 30) : over.refreshExpiresAt, actor: 'test',
}))
const connStatus = (id: string) => admin(db => db.one<{ status: string; status_reason: string | null; reauth_required_at: string | null }>('select status, status_reason, reauth_required_at from store_connections where id = $1', [id]))

describe('throttle arithmetic (no database)', () => {
  it('waits for the deficit at the restore rate, bounded, and not at all when the bucket has room', () => {
    const cost = (available: number, requested = 100) => ({ requestedQueryCost: requested, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 } })
    expect(throttleWaitMs(cost(500))).toBe(0)
    expect(throttleWaitMs(cost(50))).toBe(500)
    expect(throttleWaitMs(cost(99))).toBe(250) // never shorter than 250 ms
    expect(throttleWaitMs(cost(0, 100000))).toBe(10_000) // never longer than 10 s
    expect(throttleWaitMs(null)).toBe(0)
    expect(throttleWaitMs({ throttleStatus: { currentlyAvailable: 0, restoreRate: 0 } }, 10)).toBe(0)
  })
})

describe.skipIf(!ready)('expiring offline tokens: refresh with rotation, fail closed, reauth', () => {
  it('refreshes an expired token once, stores the rotated refresh token, and reuses the new access token', async () => {
    const c = await installed()
    await expire(c)
    const ep = tokenEndpoint([json({ access_token: 'shpat_new', scope: 'read_products,read_inventory,read_locations,write_products', expires_in: 3600, refresh_token: 'shprt_new', refresh_token_expires_in: 7776000 })])
    expect(await currentAccessToken(c, new Date(), ep.fetchImpl)).toBe('shpat_new')
    expect(ep.calls).toHaveLength(1)
    expect(ep.calls[0].url).toBe(`https://${c.external_id}/admin/oauth/access_token`)
    expect(ep.calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'shprt_old', client_id: 'test-api-key' })
    const cred = await admin(db => loadCredential(db, c.id))
    expect(cred).toMatchObject({ secret: 'shpat_new', refreshSecret: 'shprt_new' })
    expect(new Date(cred!.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 3000e3)
    // the granted scopes Shopify reported with the token are kept
    expect((await admin(db => loadConnection(db, c.id)))!.scopes).toContain('write_products')
    // fresh now: no second request
    expect(await currentAccessToken(c, new Date(), ep.fetchImpl)).toBe('shpat_new')
    expect(ep.calls).toHaveLength(1)
  })

  it('keeps the previous refresh token when the response does not rotate it', async () => {
    const c = await installed()
    await expire(c)
    const ep = tokenEndpoint([json({ access_token: 'shpat_norotate', scope: '', expires_in: 3600 })])
    expect(await currentAccessToken(c, new Date(), ep.fetchImpl)).toBe('shpat_norotate')
    expect(await admin(db => loadCredential(db, c.id))).toMatchObject({ refreshSecret: 'shprt_old' })
  })

  it('a refused refresh token deletes the credential and marks the connection as needing the merchant; reopening the app clears it', async () => {
    const c = await installed()
    await expire(c)
    const ep = tokenEndpoint([json({ error: 'invalid_grant' }, 400)])
    await expect(currentAccessToken(c, new Date(), ep.fetchImpl)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/open Deploi from the Shopify admin/) })
    expect(await admin(db => loadCredential(db, c.id))).toBeNull()
    expect(await connStatus(c.id)).toMatchObject({ status: 'error', status_reason: expect.stringMatching(/^needs_reauth: refresh refused \(HTTP 400\)/) })
    const events = await admin(db => db.query<{ event: string }>(`select event from engine_audit where connection_id = $1 order by id`, [c.id]))
    expect(events.map(e => e.event)).toEqual(expect.arrayContaining(['credential.deleted', 'connection.needs_reauth']))
    // nothing can read the store meanwhile, and no token request is made
    await expect(currentAccessToken(c, new Date(), tokenEndpoint([]).fetchImpl)).rejects.toBeInstanceOf(ShopifyApiError)
    // the merchant opens the app: token exchange runs again and the connection is active
    const r = await ensureInstalled(c.external_id, 'id-token', { exchange: async () => ({ accessToken: 'shpat_again', scope: c.scopes, expiresIn: 3600, refreshToken: 'shprt_again', refreshTokenExpiresIn: 7776000 }), info: async () => ({ name: 'Token Test (synthetic)', timezone: 'UTC' }) })
    expect(r).toMatchObject({ tokenExchanged: true, created: false })
    expect(await connStatus(c.id)).toMatchObject({ status: 'active', status_reason: null, reauth_required_at: null })
  })

  it('a temporary failure (5xx, network) fails closed without dropping the credential', async () => {
    const c = await installed()
    await expire(c)
    for (const fail of [json({}, 503), new Error('socket hang up')]) {
      await expect(currentAccessToken(c, new Date(), tokenEndpoint([fail]).fetchImpl)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/nothing was sent/) })
      expect(await admin(db => loadCredential(db, c.id))).toMatchObject({ secret: 'shpat_old', refreshSecret: 'shprt_old' })
      expect(await connStatus(c.id)).toMatchObject({ status: 'active' })
    }
  })

  it('an expired refresh token, or none, needs the merchant without calling Shopify', async () => {
    for (const over of [{ refreshExpiresAt: new Date(Date.now() - 1000) }, { refresh: null }]) {
      const c = await installed()
      await expire(c, over)
      const ep = tokenEndpoint([])
      await expect(currentAccessToken(c, new Date(), ep.fetchImpl)).rejects.toMatchObject({ kind: 'auth' })
      expect(ep.calls).toHaveLength(0)
      expect((await connStatus(c.id))!.status).toBe('error')
    }
  })
})

describe.skipIf(!ready)('GraphQL throttling and errors (fake transport)', () => {
  afterEach(() => { setTransportOverride(null); setSleep(null); resetThrottleState() })

  it('backs off on THROTTLED by extensions.cost, paces the next request, retries a throttled mutation, and maps ACCESS_DENIED to auth', async () => {
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    const waits: number[] = []
    setSleep(async ms => { waits.push(ms) })
    const throttled = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 752, actualQueryCost: null, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 452, restoreRate: 100 } } } }
    const okLow = { data: { shop: { id: 'x' } }, extensions: { cost: { requestedQueryCost: 752, actualQueryCost: 700, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } } } }
    const queue: unknown[] = [throttled, okLow, okLow]
    const seen: string[] = []
    setTransportOverride((): Transport => async body => { seen.push(body.operationName); return { status: 200, json: queue.shift() } })
    expect(await shopifyGraphql(conn, { query: 'q', operationName: 'DeploiShop' })).toEqual({ shop: { id: 'x' } })
    expect(waits[0]).toBe(3000) // (752 - 452) / 100 per second
    expect(pacingWaitMs(conn.id)).toBeGreaterThan(0) // the bucket is low: the next request waits first
    await shopifyGraphql(conn, { query: 'q', operationName: 'DeploiShop' })
    expect(waits.length).toBe(2)
    expect(waits[1]).toBeGreaterThan(5000)

    // a mutation is retried on THROTTLED (it did not run) but never on a lost response
    const mq: unknown[] = [throttled, { data: { ok: true } }]
    setTransportOverride((): Transport => async () => ({ status: 200, json: mq.shift() }))
    expect(await shopifyGraphql(conn, { query: 'm', operationName: 'DeploiSetInventoryPolicy' }, { mutation: true })).toEqual({ ok: true })
    let n = 0
    setTransportOverride((): Transport => async () => { n++; throw new Error('connection reset') })
    await expect(shopifyGraphql(conn, { query: 'm', operationName: 'DeploiSetInventoryPolicy' }, { mutation: true })).rejects.toMatchObject({ kind: 'network' })
    expect(n).toBe(1)

    setTransportOverride((): Transport => async () => ({ status: 200, json: { errors: [{ message: 'Access denied for inventoryItem field.', extensions: { code: 'ACCESS_DENIED' } }] } }))
    await expect(shopifyGraphql(conn, { query: 'q', operationName: 'DeploiShop' })).rejects.toMatchObject({ kind: 'auth' })
    expect(seen).toEqual(['DeploiShop', 'DeploiShop', 'DeploiShop'])
  })

  it('a SKU write refused for missing access is blocked with the write_inventory explanation', async () => {
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    setTransportOverride((): Transport => async () => ({ status: 200, json: { errors: [{ message: 'Access denied for inventoryItem field. Required access: `write_inventory` access scope.', extensions: { code: 'ACCESS_DENIED' } }] } }))
    const r = await shopifyConnector.applyAction(conn, { actionKey: 'shopify.variant.set_sku', targetType: 'variant', targetId: 'gid://shopify/ProductVariant/1', targetLabel: 'x',
      change: { field: 'sku', from: 'A', to: 'B' }, params: { productId: 'gid://shopify/Product/1' }, preconditions: [] })
    expect(r).toMatchObject({ outcome: 'rejected', blocked: true })
    expect(r.error).toMatch(/write_inventory scope/)
  })

  it('unpublish verification: a channel missing from a complete resourcePublicationsV2 list reads as not published', async () => {
    const conn = { ...(await admin(db => loadConnection(db, NW.conn)))!, id: '00000000-0000-4000-8000-00000000abcd' }
    const PUB_A = 'gid://shopify/Publication/501', PUB_B = 'gid://shopify/Publication/502'
    const variant = { id: 'gid://shopify/ProductVariant/9', title: 'Default Title', sku: 'S', inventoryPolicy: 'DENY', price: '1.00', compareAtPrice: null, barcodes: { nodes: [] }, sellingPlanGroupsCount: { count: 0 },
      product: { id: 'gid://shopify/Product/9', title: 'P', handle: 'p', status: 'ACTIVE', tags: [], isGiftCard: false, requiresSellingPlan: false, sellingPlanGroupsCount: { count: 0 }, onlineStoreUrl: null, updatedAt: '2026-11-01T00:00:00Z',
        resourcePublicationsV2: { pageInfo: { hasNextPage: false }, nodes: [{ publication: { id: PUB_B }, isPublished: true, publishDate: null }] } },
      inventoryItem: { id: 'gid://shopify/InventoryItem/9', tracked: true, duplicateSkuCount: 0, inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: [] } } }
    setTransportOverride((): Transport => async body => ({ status: 200, json: body.operationName === 'DeploiPublications'
      ? { data: { shop: { currencyCode: 'USD' }, publications: { nodes: [PUB_A, PUB_B].map(id => ({ id, supportsFuturePublishing: true, catalog: { title: id, status: 'ACTIVE' } })) } } }
      : { data: { nodes: [{ __typename: 'Product', id: variant.product.id, variants: { nodes: [variant] } }] } } }))
    const out = await shopifyConnector.readResources(conn, ['gid://shopify/Product/9'])
    const r = out.get('gid://shopify/ProductVariant/9') as unknown as { published: Record<string, boolean> }
    expect(r.published).toEqual({ [PUB_A]: false, [PUB_B]: true })
    // an incomplete list (more pages) is not read as "absent = unpublished"
    variant.product.resourcePublicationsV2.pageInfo.hasNextPage = true
    const out2 = await shopifyConnector.readResources(conn, ['gid://shopify/Product/9'])
    expect((out2.get('gid://shopify/ProductVariant/9') as unknown as { published: Record<string, boolean> }).published).toEqual({ [PUB_B]: true })
  })
})
