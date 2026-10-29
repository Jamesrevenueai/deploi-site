/**
 * Read one competitor store's public information. Supported today: stores that publish Shopify's
 * public storefront product feed (/products.json), which most Shopify stores do. From it we read
 * products, prices, compare-at ("was") prices and availability, and from the store's own public
 * collections the ones it names as best sellers, featured or on sale, in the order the store shows them.
 * Anything else is reported as unsupported; nothing is guessed from page layouts.
 *
 * What this can never tell us: sales, revenue, units sold, conversion or any private figure. A
 * collection's order is the order the store chose to display, not a measured sales ranking.
 */
import { PoliteFetcher, type FetchResult } from './fetch'
import { robotsAllows, robotsFromResponse, type Robots } from './robots'

export type PublicProduct = {
  key: string; title: string; url: string; productType: string | null; vendor: string | null; tags: string[]
  /** lowest variant price, in the store's own currency (the feed does not state the currency) */
  price: number | null
  /** the compare-at ("was") price shown with that variant, when above the price */
  compareAt: number | null
  available: boolean | null
  publishedAt: string | null
}
export type PublicList = { title: string; handle: string; url: string; keys: string[] }
export type StoreSnapshot = {
  observedAt: string
  products: PublicProduct[]
  /** false when we stopped at the page limit: absence of a product then proves nothing */
  complete: boolean
  bestsellers: PublicList | null
  featured: PublicList[]
  urls: string[]
}
export type CollectResult =
  | { status: 'ok'; platform: 'shopify'; snapshot: StoreSnapshot; requests: number }
  | { status: 'blocked_robots' | 'unsupported' | 'unreachable'; platform: 'shopify' | 'unsupported' | 'unknown'; reason: string; requests: number; urls: string[] }

const PAGE_SIZE = 250
const MAX_PAGES = 4
const MAX_LISTS = 3
const BESTSELLER = /(^|-)(best-?sell(er|ers|ing)?|top-?sell(er|ers|ing)?|most-?popular|popular|trending)(-|$)/
const FEATURED = /(^|-)(featured|new-?arrivals?|new-?in|just-?in|sale|deals?|clearance|promo(tion)?s?|offers?)(-|$)/

const num = (v: unknown): number | null => { const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null }
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const json = (r: FetchResult): unknown => { if (r.status !== 200) return null; try { return JSON.parse(r.body) } catch { return null } }

export function productFromFeed(origin: string, p: Record<string, unknown>): PublicProduct | null {
  const handle = text(p.handle, 255)
  const title = text(p.title)
  if (!handle || !title || !/^[a-z0-9][a-z0-9-_.]*$/i.test(handle)) return null
  const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : []
  let best: { price: number; compareAt: number | null } | null = null
  for (const v of variants) {
    const price = num(v.price)
    if (price === null) continue
    if (!best || price < best.price) { const ca = num(v.compare_at_price); best = { price, compareAt: ca !== null && ca > price ? ca : null } }
  }
  const avail = variants.map(v => v.available).filter((a): a is boolean => typeof a === 'boolean')
  const rawTags = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',') : []
  return {
    key: handle.toLowerCase(), title, url: `${origin}/products/${encodeURIComponent(handle)}`,
    productType: text(p.product_type, 120) || null, vendor: text(p.vendor, 120) || null,
    tags: rawTags.map(t => text(t, 60).toLowerCase()).filter(Boolean).slice(0, 50),
    price: best?.price ?? null, compareAt: best?.compareAt ?? null,
    available: avail.length ? avail.some(Boolean) : null,
    publishedAt: typeof p.published_at === 'string' && !Number.isNaN(Date.parse(p.published_at)) ? new Date(p.published_at).toISOString() : null,
  }
}

export async function collectStore(origin: string, opts: { fetcher?: PoliteFetcher; now?: Date } = {}): Promise<CollectResult> {
  const f = opts.fetcher ?? new PoliteFetcher()
  const urls: string[] = []
  const get = async (path: string) => { const r = await f.get(`${origin}${path}`); urls.push(`${origin}${path}`); return r }
  const fail = (status: 'blocked_robots' | 'unsupported' | 'unreachable', platform: 'shopify' | 'unsupported' | 'unknown', reason: string): CollectResult => ({ status, platform, reason, requests: f.requests, urls })

  // 1. robots.txt decides whether we may read anything at all
  const rb = await get('/robots.txt')
  if (rb.status === 0) return fail('unreachable', 'unknown', `the store could not be reached: ${'error' in rb ? rb.error : 'no response'}`)
  const robots: Robots = robotsFromResponse(rb.status, rb.body)
  const allowed = (path: string) => robotsAllows(robots, path)
  if (robots.kind === 'disallow_all') return fail('blocked_robots', 'unknown', robots.reason)
  if (!allowed('/products.json')) return fail('blocked_robots', 'unknown', "the store's robots.txt does not allow reading its product feed, so it is not checked")

  // 2. the public product feed (also tells us whether the store is supported)
  const products: PublicProduct[] = []
  let complete = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/products.json?limit=${PAGE_SIZE}&page=${page}`
    if (!allowed(path)) return fail('blocked_robots', 'shopify', "the store's robots.txt does not allow reading its product feed, so it is not checked")
    const r = await get(path)
    if (r.status === 0) return fail('unreachable', 'unknown', `the store could not be reached: ${'error' in r ? r.error : 'no response'}`)
    const body = json(r) as { products?: unknown } | null
    if (!body || !Array.isArray(body.products)) {
      if (page === 1) return fail('unsupported', 'unsupported', r.status === 200 ? 'the store does not publish a public product feed Deploi can read' : `the store's product feed answered HTTP ${r.status}`)
      break
    }
    for (const raw of body.products as Record<string, unknown>[]) { const p = productFromFeed(origin, raw); if (p && !products.some(x => x.key === p.key)) products.push(p) }
    if (body.products.length < PAGE_SIZE) { complete = true; break }
  }

  // 3. the store's own public collections it names as best sellers, featured, new or on sale
  let bestsellers: PublicList | null = null
  const featured: PublicList[] = []
  if (allowed('/collections.json?limit=250')) {
    const cr = json(await get('/collections.json?limit=250')) as { collections?: { handle?: unknown; title?: unknown }[] } | null
    const cols = (cr?.collections ?? []).map(c => ({ handle: text(c.handle, 120).toLowerCase(), title: text(c.title, 120) })).filter(c => c.handle && /^[a-z0-9][a-z0-9-_.]*$/.test(c.handle))
    const wanted = [...cols.filter(c => BESTSELLER.test(c.handle)).slice(0, 1), ...cols.filter(c => FEATURED.test(c.handle) && !BESTSELLER.test(c.handle))].slice(0, MAX_LISTS)
    for (const c of wanted) {
      const path = `/collections/${c.handle}/products.json?limit=${PAGE_SIZE}`
      if (!allowed(path)) continue
      const body = json(await get(path)) as { products?: Record<string, unknown>[] } | null
      if (!body || !Array.isArray(body.products)) continue
      const keys = body.products.map(p => text(p.handle, 255).toLowerCase()).filter(Boolean)
      const list = { title: c.title || c.handle, handle: c.handle, url: `${origin}/collections/${c.handle}`, keys }
      if (BESTSELLER.test(c.handle) && !bestsellers) bestsellers = list
      else featured.push(list)
    }
  }
  return { status: 'ok', platform: 'shopify', requests: f.requests, snapshot: { observedAt: (opts.now ?? new Date()).toISOString(), products, complete, bestsellers, featured, urls } }
}
