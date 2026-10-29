/**
 * Public Shopify storefront source. Reads only what any visitor's browser can read without signing in:
 *   /robots.txt                                    obeyed for every request below
 *   /meta.json                                     store name, currency, published product count
 *   /products.json?limit=250&page=N                public product feed (titles, prices, availability)
 *   /collections/<handle>/products.json            the store's own bestseller collection, in its displayed order
 * It never signs in, never adds to a cart, never uses sort_by (Shopify's default robots.txt disallows it),
 * never retries through a block, and stops at the first 401/403/429 or challenge page.
 */
import { FetchRefused, safeFetch, type SafeResponse } from '../../net/safe-fetch'
import { robotsAllows, robotsFromResponse, type RobotsRules } from '../../net/robots'
import { currencyOf, plainText, productOf } from '../normalize'
import type { BestsellerObservation, CollectBudget, CollectResult, CompetitorSource, ObservedProduct } from '../types'

export type Fetcher = (url: string, opts: { accept?: RegExp; maxBytes?: number }) => Promise<SafeResponse>
const defaultFetcher: Fetcher = (url, opts) => safeFetch(url, { ...opts, timeoutMs: 15000 })

/** Common handles stores give their own bestseller collection; tried only when the merchant named none. */
export const BESTSELLER_HANDLES = ['best-sellers', 'bestsellers', 'best-selling']
const PAGE = 250
const JSON_TYPE = /json/

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())

/** A response that means "stop now, do not work around it". */
function blockedReason(r: SafeResponse): { status: 'blocked' | 'rate_limited'; reason: string } | null {
  if (r.status === 429) return { status: 'rate_limited', reason: 'the store asked us to slow down (429); the next check will try again' }
  if (r.status === 401 || r.status === 403) return { status: 'blocked', reason: `the store refused access (${r.status}); Deploi does not bypass access controls` }
  if (r.status === 503 && /captcha|challenge|cf-chl|verify you are human/i.test(r.body)) return { status: 'blocked', reason: 'the store shows a bot challenge; Deploi does not bypass it' }
  if (r.status >= 200 && r.status < 300 && /text\/html/.test(r.contentType) && /captcha|challenge-platform|verify you are human|password-page/i.test(r.body)) return { status: 'blocked', reason: 'the store shows a challenge or password page instead of its feed' }
  return null
}

export function shopifyPublicSource(fetcher: Fetcher = defaultFetcher): CompetitorSource {
  return {
    key: 'shopify_public',
    label: 'Public Shopify storefront',
    coverage: [
      'Sees: product titles, types, tags, prices and compare-at prices in the store’s default currency, whether each variant is shown as available, and the date the store says a product was published.',
      'Sees, when the store publishes one: the order of its own bestseller collection, as the store chose to display it.',
      'Cannot see: sales, revenue, units, stock counts, ad spend, other regions’ prices, or anything behind a login.',
    ],
    async collect({ origin, bestsellerHandle, budget }): Promise<CollectResult> {
      let used = 0
      const urls: string[] = []
      const get = async (path: string, opts: { accept?: RegExp } = {}) => {
        if (used >= budget.maxRequests) return null
        if (used > 0) await sleep(budget.delayMs)
        used++
        const url = `${origin}${path}`
        urls.push(url)
        return fetcher(url, { accept: opts.accept, maxBytes: 6 * 1024 * 1024 })
      }
      const fail = (status: Exclude<CollectResult['status'], 'supported'>, reason: string): CollectResult => ({ ok: false, status, reason, requestsUsed: used })
      try {
        // robots.txt first: a store that cannot be asked is not read
        let robots: RobotsRules
        try {
          const r = await get('/robots.txt')
          robots = r ? robotsFromResponse(r.status, r.body) : { kind: 'disallow_all', reason: 'no request budget' }
        } catch (e) {
          if (e instanceof FetchRefused && ['bad_url', 'private_address', 'redirect_off_site'].includes(e.code)) return fail('blocked', e.message)
          robots = robotsFromResponse(null, '')
        }
        if (robots.kind === 'disallow_all') return fail(robots.reason.includes('rate') ? 'rate_limited' : 'error', robots.reason)
        const delayMs = Math.max(budget.delayMs, Math.min(10, robots.kind === 'rules' ? robots.crawlDelaySeconds ?? 0 : 0) * 1000)
        budget = { ...budget, delayMs }
        const allowed = (p: string) => robotsAllows(robots, p)
        if (!allowed('/products.json')) return fail('blocked', 'the store’s robots.txt does not allow reading its product feed')

        // store metadata: currency and the published product count (used to prove a read was complete)
        let currency: string | null = null, storeName: string | null = null, publishedCount: number | null = null
        if (allowed('/meta.json')) {
          const m = await get('/meta.json', { accept: JSON_TYPE }).catch(() => null)
          if (m) {
            const b = blockedReason(m); if (b) return fail(b.status, b.reason)
            if (m.status === 200) {
              try {
                const j = JSON.parse(m.body) as Record<string, unknown>
                currency = currencyOf(j.currency)
                storeName = plainText(j.name, 120) || null
                publishedCount = typeof j.published_products_count === 'number' ? j.published_products_count : null
              } catch { /* not a Shopify storefront, or not JSON: decided by the feed below */ }
            }
          }
        }

        // the product feed, page by page
        const products: ObservedProduct[] = []
        const seen = new Set<string>()
        let complete = false, incompleteReason: string | null = null
        for (let page = 1; ; page++) {
          if (products.length >= budget.maxProducts) { incompleteReason = `stopped at the limit of ${budget.maxProducts} products for this store`; break }
          const path = `/products.json?limit=${PAGE}&page=${page}`
          const r = await get(path, { accept: JSON_TYPE }).catch(e => { if (e instanceof FetchRefused && e.code === 'bad_content_type') return 'not_json' as const; throw e })
          if (r === null) { incompleteReason = 'request budget used up before the last page'; break }
          if (r === 'not_json') { if (page === 1) return fail('unsupported', 'this store does not publish a Shopify product feed Deploi can read'); incompleteReason = 'a later page was not a product feed'; break }
          const b = blockedReason(r)
          if (b) { if (page === 1) return fail(b.status, b.reason); incompleteReason = b.reason; break }
          if (r.status === 404 && page === 1) return fail('unsupported', 'this store does not publish a Shopify product feed Deploi can read')
          if (r.status !== 200) { if (page === 1) return fail('error', `the product feed answered ${r.status}`); incompleteReason = `page ${page} answered ${r.status}`; break }
          let list: unknown[]
          try {
            const j = JSON.parse(r.body) as { products?: unknown }
            if (!Array.isArray(j.products)) throw new Error('no products array')
            list = j.products
          } catch {
            if (page === 1) return fail('unsupported', 'this store does not publish a Shopify product feed Deploi can read')
            incompleteReason = `page ${page} could not be read`; break
          }
          for (const raw of list) {
            const p = productOf(raw, origin)
            if (p && !seen.has(p.externalId) && products.length < budget.maxProducts) { seen.add(p.externalId); products.push(p) }
          }
          if (list.length < PAGE) { complete = true; break }
        }
        // a store that says it publishes more products than we read did not give us the whole catalogue
        if (complete && publishedCount !== null && products.length < Math.floor(publishedCount * 0.98)) {
          complete = false
          incompleteReason = `read ${products.length} of the ${publishedCount} products the store reports`
        }

        // the store's own bestseller collection, if it has one we may read
        let bestseller: BestsellerObservation = { status: 'unavailable', reason: 'this store does not publish a bestseller collection Deploi found' }
        const handles = bestsellerHandle ? [bestsellerHandle] : BESTSELLER_HANDLES
        for (const h of handles) {
          const path = `/collections/${encodeURIComponent(h)}/products.json?limit=${PAGE}`
          if (!allowed(path)) { bestseller = { status: 'unavailable', reason: 'the store’s robots.txt does not allow reading its bestseller collection' }; continue }
          const r = await get(path, { accept: JSON_TYPE }).catch(() => null)
          if (!r) { if (used >= budget.maxRequests) { bestseller = { status: 'unavailable', reason: 'request budget used up before the bestseller collection' }; break } continue }
          if (r.status !== 200) continue
          try {
            const j = JSON.parse(r.body) as { products?: unknown[] }
            if (!Array.isArray(j.products) || !j.products.length) continue
            const ranked = j.products.map(x => productOf(x, origin)?.externalId).filter((x): x is string => Boolean(x))
            bestseller = { status: 'observed', handle: h, url: `${origin}/collections/${encodeURIComponent(h)}`, ranked }
            break
          } catch { continue }
        }
        if (bestseller.status === 'unavailable' && bestsellerHandle) bestseller = { status: 'unavailable', reason: `the collection "${bestsellerHandle}" could not be read` }

        return { ok: true, status: 'supported', snapshot: { fetchedAt: new Date(), currency, storeName, complete, incompleteReason, products, bestseller, requestsUsed: used, sourceUrls: urls } }
      } catch (e) {
        if (e instanceof FetchRefused) {
          if (['bad_url', 'private_address', 'redirect_off_site'].includes(e.code)) return fail('blocked', e.message)
          return fail('error', e.message)
        }
        return fail('error', `could not read the store: ${(e as Error).message.slice(0, 160)}`)
      }
    },
  }
}

/** Sources by key. Others (licensed feeds, search-trend APIs) plug in here once the merchant connects them. */
export const COMPETITOR_SOURCES: Record<string, () => CompetitorSource> = {
  shopify_public: () => shopifyPublicSource(),
}

/** Data providers a merchant may connect later. None is connected or implemented yet; the UI shows them as unavailable. */
export const PLANNED_PROVIDERS = [
  { key: 'search_trends', label: 'Search trends', status: 'unavailable' as const, reason: 'No search-trend provider is connected. Wider market trends are not shown.' },
  { key: 'licensed_feed', label: 'Licensed market data', status: 'unavailable' as const, reason: 'No licensed data feed is connected.' },
]

export type { BestsellerObservation, CollectBudget }
