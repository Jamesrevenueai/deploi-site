/** A fake public Shopify storefront for tests: serves robots.txt, meta.json, products.json pages and collections. */
import type { SafeResponse } from '../../lib/net/safe-fetch'
import type { Fetcher } from '../../lib/competitors/sources/shopify-public'

export type FakeVariant = { id: number; title?: string; price: string; compare_at_price?: string | null; available?: boolean }
export type FakeProduct = { id: number; handle: string; title: string; product_type?: string; tags?: string[]; published_at?: string; variants: FakeVariant[] }
export type FakeStore = {
  products: FakeProduct[]
  currency?: string | null
  robots?: string | null
  bestsellers?: { handle: string; ids: number[] } | null
  /** paths that answer this status instead */
  fail?: Record<string, number>
  /** every request answers with this (e.g. 503 outage) */
  down?: number | null
  html?: boolean
  /** report more products than the feed returns */
  reportedCount?: number
}

export function fakeFetcher(stores: Record<string, FakeStore>, log: string[] = []): Fetcher {
  return async (url: string) => {
    log.push(url)
    const u = new URL(url)
    const s = stores[u.origin]
    const res = (status: number, body: unknown, type = 'application/json'): SafeResponse => ({ status, url, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type }, fetchedAt: new Date() })
    if (!s) return res(404, 'not found', 'text/html')
    if (s.down) return res(s.down, 'down', 'text/html')
    const path = u.pathname
    if (s.fail?.[path] || s.fail?.[path + u.search]) return res(s.fail[path] ?? s.fail[path + u.search], 'nope', 'text/html')
    if (path === '/robots.txt') return s.robots === null ? res(404, '', 'text/plain') : res(200, s.robots ?? 'User-agent: *\nDisallow: /cart\nDisallow: /collections/*sort_by*\n', 'text/plain')
    if (s.html) return res(200, '<html>shop</html>', 'text/html')
    if (path === '/meta.json') return res(200, { name: 'Fake', currency: s.currency === undefined ? 'USD' : s.currency, published_products_count: s.reportedCount ?? s.products.length })
    if (path === '/products.json') {
      const page = Number(u.searchParams.get('page') ?? 1), limit = Number(u.searchParams.get('limit') ?? 30)
      return res(200, { products: s.products.slice((page - 1) * limit, page * limit) })
    }
    const m = path.match(/^\/collections\/([^/]+)\/products\.json$/)
    if (m && s.bestsellers && decodeURIComponent(m[1]) === s.bestsellers.handle) {
      return res(200, { products: s.bestsellers.ids.map(id => s.products.find(p => p.id === id)).filter(Boolean) })
    }
    return res(404, 'not found', 'text/html')
  }
}

export const product = (id: number, title: string, price: string, extra: Partial<FakeProduct> = {}, v: Partial<FakeVariant> = {}): FakeProduct => ({
  id, handle: `p-${id}`, title, product_type: extra.product_type ?? '', tags: extra.tags ?? [], published_at: extra.published_at ?? '2026-01-01T00:00:00Z',
  variants: [{ id: id * 10, title: 'Default Title', price, compare_at_price: null, available: true, ...v }], ...extra,
})
