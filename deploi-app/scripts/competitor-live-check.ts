/**
 * Read-only live check of the public Shopify source against real stores (no database, nothing stored):
 *   npx tsx scripts/competitor-live-check.ts https://www.example-store.com [more stores]
 * Obeys robots.txt, waits 1 s between requests and uses at most 6 requests per store. In a sandbox that
 * reaches the internet only through a CONNECT proxy, set PUBLIC_FETCH_PROXY (never used in production).
 */
import { shopifyPublicSource } from '../lib/competitors/sources/shopify-public'

async function main() {
  for (const origin of process.argv.slice(2)) {
    const r = await shopifyPublicSource().collect({ origin: origin.replace(/\/$/, ''), bestsellerHandle: null, budget: { maxRequests: 6, maxProducts: 500, delayMs: 1000 } })
    if (!r.ok) { console.log(JSON.stringify({ origin, ...r })); continue }
    const s = r.snapshot
    console.log(JSON.stringify({
      origin, fetchedAt: s.fetchedAt, currency: s.currency, storeName: s.storeName, complete: s.complete, incompleteReason: s.incompleteReason,
      products: s.products.length, requests: s.requestsUsed, urls: s.sourceUrls,
      bestseller: s.bestseller.status === 'observed' ? { handle: s.bestseller.handle, top3: s.bestseller.ranked.slice(0, 3) } : s.bestseller,
      sample: s.products.slice(0, 2).map(p => ({ title: p.title, url: p.url, publishedAt: p.publishedAt, variants: p.variants.slice(0, 2) })),
    }, null, 1))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
