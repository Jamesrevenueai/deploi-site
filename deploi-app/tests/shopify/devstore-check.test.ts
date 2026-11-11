import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { runDevstoreCheck, assertReadOnly, formatReport } from '../../lib/connectors/shopify/devstore-check'
import { M_PUBLISH, M_UPDATE_VARIANT, Q_SHOP, Q_VARIANTS } from '../../lib/connectors/shopify/queries'

const SHOP = 'deploi-dev-check.myshopify.com'

function fakeShopify(opts: { dev?: boolean; scopes?: string[]; domain?: string; status?: number } = {}) {
  const ops: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`)
    const body = JSON.parse(String(init.body)) as { query: string; operationName: string }
    ops.push(body.operationName)
    if (opts.status) return new Response('{}', { status: opts.status })
    const data: Record<string, unknown> = {
      DeploiShop: { shop: { id: 'gid://shopify/Shop/1', name: 'Dev check', myshopifyDomain: opts.domain ?? SHOP, plan: { publicDisplayName: opts.dev === false ? 'Basic' : 'Development', partnerDevelopment: opts.dev !== false } } },
      DeploiAccessScopes: { currentAppInstallation: { accessScopes: (opts.scopes ?? ['read_products', 'write_products', 'read_inventory', 'read_locations', 'read_publications']).map(handle => ({ handle })) } },
      DeploiVariants: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'gid://shopify/ProductVariant/1', title: 'Default Title', sku: 'A', inventoryPolicy: 'DENY', product: { id: 'gid://shopify/Product/1', title: 'P', status: 'ACTIVE', tags: [] }, inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true, inventoryLevels: { nodes: [{ location: { id: 'l', name: 'L' }, quantities: [{ name: 'available', quantity: 0 }] }] } } }] } },
      DeploiPublications: { shop: { currencyCode: 'USD' }, publications: { nodes: [{ id: 'gid://shopify/Publication/1', catalog: { title: 'Online Store', status: 'ACTIVE' } }] } },
    }
    return new Response(JSON.stringify({ data: data[body.operationName], extensions: { cost: { requestedQueryCost: 52, actualQueryCost: 12, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1988, restoreRate: 100 } } } }), { status: 200 })
  }) as unknown as typeof fetch
  return { ops, fetchImpl }
}

describe('dev-store smoke check (fake Shopify, no network)', () => {
  it('passes on a development store, reading only: shop, scopes, one page of variants, publications', async () => {
    const f = fakeShopify()
    const r = await runDevstoreCheck({ shop: SHOP, accessToken: 'shpat_fake', apiVersion: '2026-10', fetchImpl: f.fetchImpl })
    expect(r).toMatchObject({ ok: true, refused: null })
    expect(f.ops).toEqual(['DeploiShop', 'DeploiAccessScopes', 'DeploiVariants', 'DeploiPublications'])
    const text = formatReport(r)
    expect(text).toMatch(/PASS {2}variants \(one page\): 1 variant\(s\) read, 1 tracked, 1 at or below zero available; query cost requested 52, actual 12/)
    expect(text).toMatch(/PASS {2}publications: 1 channel\(s\): Online Store/)
  })

  it('refuses any store that is not a development store, before reading anything else', async () => {
    const f = fakeShopify({ dev: false })
    const r = await runDevstoreCheck({ shop: SHOP, accessToken: 'shpat_fake', apiVersion: '2026-10', fetchImpl: f.fetchImpl })
    expect(r.refused).toMatch(/not a development store/)
    expect(f.ops).toEqual(['DeploiShop'])
    const other = fakeShopify({ domain: 'someone-else.myshopify.com' })
    expect((await runDevstoreCheck({ shop: SHOP, accessToken: 'x', apiVersion: '2026-10', fetchImpl: other.fetchImpl })).refused).toMatch(/token belongs to/)
    expect((await runDevstoreCheck({ shop: 'evil.com', accessToken: 'x', apiVersion: '2026-10', fetchImpl: f.fetchImpl })).refused).toMatch(/myshopify/)
  })

  it('fails (without retrying or writing) on a refused token or missing scopes', async () => {
    expect((await runDevstoreCheck({ shop: SHOP, accessToken: 'x', apiVersion: '2026-10', fetchImpl: fakeShopify({ status: 401 }).fetchImpl })).lines[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/token was refused/) })
    const r = await runDevstoreCheck({ shop: SHOP, accessToken: 'x', apiVersion: '2026-10', fetchImpl: fakeShopify({ scopes: ['read_products'] }).fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.lines.find(l => l.name === 'scopes')!.detail).toMatch(/missing required scopes: write_products, read_inventory, read_locations/)
  })

  it('refuses to send a mutation', () => {
    for (const m of [M_PUBLISH, M_UPDATE_VARIANT, 'subscription X { a }', '{ a } mutation { b }']) expect(() => assertReadOnly(m)).toThrow(/refused/)
    for (const q of [Q_SHOP, Q_VARIANTS]) expect(() => assertReadOnly(q)).not.toThrow()
  })
})
