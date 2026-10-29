/**
 * Turning observed changes into insights a merchant can act on. Pure: no I/O.
 *
 * Every insight states its basis:
 *   observed     a fact read from a store's public page at a recorded time
 *   inferred     a pattern across observations (e.g. several followed stores adding the same kind of product);
 *                the inference is spelled out and labelled as such
 *   unavailable  something Deploi could not observe (a blocked store, no bestseller list, no trend source)
 * No insight claims sales, revenue, units or rankings by sales. Patterns are "among the stores you follow",
 * never "the market", because no market-wide source is connected.
 */
import { createHash } from 'node:crypto'
import type { Basis, Change, ChangeKind } from './types'
import { matchesKeyword, productText } from './normalize'

export type InsightKind = 'baseline' | 'launches' | 'newly_observed' | 'price_changes' | 'promotions' | 'availability' | 'delisted' | 'bestseller_entries' | 'cross_store_pattern' | 'source_unavailable'

export type InsightProduct = { storeId: string; store: string; title: string; url: string | null; observedAt: string; note?: string }
export type InsightDraft = {
  kind: InsightKind
  dedupeKey: string
  headline: string
  basis: Basis
  facts: string[]
  stores: { id: string; label: string }[]
  products: InsightProduct[]
  sources: { url: string; observedAt: string }[]
  periodStart: string
  periodEnd: string
  inference: string | null
  limitations: string[]
  nextAction: string
  /** meaningful changes may alert the merchant (by the alert preferences) */
  meaningful: boolean
}

export type AlertPrefs = { newLaunches: boolean; priceChangePct: number; promotions: boolean; availability: boolean; bestsellers: boolean; crossStoreMin: number; windowDays: number }
export type StoreRef = { id: string; label: string; origin: string; currency: string | null }

const LIMIT_SALES = 'Sales, revenue and units are not visible on public pages; nothing here measures them.'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const money = (n: unknown, c: string | null) => (typeof n === 'number' ? `${n.toFixed(2)}${c ? ` ${c}` : ' (currency not stated by the store)'}` : 'not observed')
const short = (s: string | null, n = 70) => (s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : (s ?? '')
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function productsOf(store: StoreRef, cs: Change[], note?: (c: Change) => string | undefined): InsightProduct[] {
  const seen = new Set<string>()
  return cs.filter(c => { const k = c.externalId ?? c.url ?? ''; if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, 50).map(c => ({ storeId: store.id, store: store.label, title: short(c.title, 120), url: c.url, observedAt: c.observedAt, note: note?.(c) }))
}

/** Per-store insights from one check. `previousCheckAt` bounds the comparison period. */
export function storeInsights(input: { runId: string; store: StoreRef; changes: Change[]; previousCheckAt: string | null; checkedAt: string; sourceUrls: string[]; prefs: AlertPrefs }): InsightDraft[] {
  const { store, changes, prefs, runId } = input
  const by = (k: ChangeKind) => changes.filter(c => c.kind === k)
  const out: InsightDraft[] = []
  const period = { periodStart: input.previousCheckAt ?? input.checkedAt, periodEnd: input.checkedAt }
  const sources = [...new Set(input.sourceUrls)].slice(0, 12).map(url => ({ url, observedAt: input.checkedAt }))
  const base = (kind: InsightKind) => ({ kind, dedupeKey: `${kind}:${store.id}:${runId}`, stores: [{ id: store.id, label: store.label }], sources, ...period })

  const baseline = by('baseline')[0]
  if (baseline) {
    out.push({ ...base('baseline'), basis: 'observed', meaningful: false,
      headline: `Baseline recorded for ${store.label}: ${plural(Number(baseline.detail.products ?? 0), 'product')}`,
      facts: [`Deploi read ${store.label}'s public product feed in full on ${input.checkedAt.slice(0, 16).replace('T', ' ')} UTC.`,
        `Prices are in ${baseline.detail.currency ?? 'a currency the store did not state'}.`,
        baseline.detail.bestseller === 'observed' ? 'The store publishes a bestseller collection; its order was recorded.' : 'No public bestseller collection was found.'],
      products: [], inference: null,
      limitations: ['This is the starting point. Products already listed are not reported as new launches.', LIMIT_SALES],
      nextAction: 'Nothing to do yet. Changes are reported from the next check.' })
    return out
  }

  const launches = by('launch')
  if (launches.length) out.push({ ...base('launches'), basis: 'observed', meaningful: prefs.newLaunches,
    headline: `${store.label} added ${plural(launches.length, 'new product')}`,
    facts: [`${plural(launches.length, 'product')} appeared in ${store.label}'s public feed with a published date after monitoring began.`,
      ...launches.slice(0, 5).map(c => `${short(c.title)}: published ${String(c.detail.publishedAt ?? '').slice(0, 10)}, from ${money(c.detail.priceMin, (c.detail.currency as string) ?? store.currency)}${typeof c.detail.bestsellerRank === 'number' ? `, shown at position ${c.detail.bestsellerRank} of its bestseller collection` : ''}.`)],
    products: productsOf(store, launches), inference: null,
    limitations: ['The published date is the store’s own. A launch says nothing about how well a product sells.', LIMIT_SALES],
    nextAction: 'Open the products and decide whether similar items fit your store. You can turn this into a sourcing request draft for your Supplier Chaser.' })

  const newly = by('newly_observed')
  if (newly.length) out.push({ ...base('newly_observed'), basis: 'observed', meaningful: false,
    headline: `${plural(newly.length, 'product')} newly visible at ${store.label} (dated before monitoring)`,
    facts: [`These products were not in earlier complete checks, but the store dates them before monitoring began.`],
    products: productsOf(store, newly, c => c.detail.publishedAt ? `store's published date ${String(c.detail.publishedAt).slice(0, 10)}` : 'no published date'), inference: null,
    limitations: ['They may have been republished, unhidden or moved into the public feed; they are not counted as launches.', LIMIT_SALES],
    nextAction: 'No action needed unless one of them interests you.' })

  const prices = by('price_change')
  if (prices.length) {
    const big = prices.filter(c => typeof c.detail.pct === 'number' && Math.abs(c.detail.pct as number) >= prefs.priceChangePct)
    const down = prices.filter(c => (c.detail.pct as number) < 0).length, up = prices.length - down
    const range = prices.map(c => Math.abs(c.detail.pct as number)).filter(n => Number.isFinite(n))
    out.push({ ...base('price_changes'), basis: 'observed', meaningful: big.length > 0,
      headline: `${store.label} changed prices on ${plural(new Set(prices.map(c => c.externalId)).size, 'product')}${down && up ? ` (${down} lower, ${up} higher)` : down ? ' (lower)' : ' (higher)'}`,
      facts: [`Compared the same variants in the same currency (${store.currency ?? 'as stated by the store'}) between two checks.`,
        range.length ? `Changes ranged from ${Math.min(...range)}% to ${Math.max(...range)}%.` : '',
        ...prices.slice(0, 6).map(c => `${short(c.title)}${c.detail.variant && c.detail.variant !== 'Default' && c.detail.variant !== 'Default Title' ? ` (${short(String(c.detail.variant), 30)})` : ''}: ${money(c.detail.from, c.detail.currency as string)} → ${money(c.detail.to, c.detail.currency as string)} (${c.detail.pct}%).`)].filter(Boolean),
      products: productsOf(store, prices), inference: null,
      limitations: ['Prices are the store’s default-currency list prices; other regions, discount codes and checkout prices may differ.', LIMIT_SALES],
      nextAction: big.length ? `Compare with your own prices for similar products. Deploi will not change your prices.` : 'Small changes; no action suggested.' })
  }

  const promos = by('promotion_started')
  if (promos.length) out.push({ ...base('promotions'), basis: 'observed', meaningful: prefs.promotions,
    headline: `${store.label} started showing sale prices on ${plural(new Set(promos.map(c => c.externalId)).size, 'product')}`,
    facts: [`A compare-at price above the selling price appeared since the previous check.`,
      ...promos.slice(0, 5).map(c => `${short(c.title)}: ${money(c.detail.price, c.detail.currency as string)}, was shown as ${money(c.detail.compareAt, c.detail.currency as string)}.`)],
    products: productsOf(store, promos), inference: null,
    limitations: ['A compare-at price is how the store presents a discount; it does not show how long the sale lasts or whether it works.', LIMIT_SALES],
    nextAction: 'Check whether the promoted products overlap with yours before deciding on any promotion of your own.' })

  const ended = by('promotion_ended')
  if (ended.length) out.push({ ...base('promotions'), dedupeKey: `promotions_ended:${store.id}:${runId}`, basis: 'observed', meaningful: false,
    headline: `${store.label} stopped showing sale prices on ${plural(new Set(ended.map(c => c.externalId)).size, 'product')}`,
    facts: ['The compare-at price is no longer shown above the selling price.'], products: productsOf(store, ended), inference: null,
    limitations: [LIMIT_SALES], nextAction: 'No action needed.' })

  const unavail = by('became_unavailable'), avail = by('became_available')
  if (unavail.length || avail.length) out.push({ ...base('availability'), basis: 'observed', meaningful: prefs.availability && unavail.length > 0,
    headline: `${store.label}: ${unavail.length ? `${plural(new Set(unavail.map(c => c.externalId)).size, 'product')} now shown as unavailable` : ''}${unavail.length && avail.length ? ', ' : ''}${avail.length ? `${plural(new Set(avail.map(c => c.externalId)).size, 'product')} available again` : ''}`,
    facts: ['What the public feed shows for each variant, compared between two checks.'],
    products: [...productsOf(store, unavail, () => 'shown as unavailable'), ...productsOf(store, avail, () => 'available again')], inference: null,
    limitations: ['"Unavailable" may mean sold out, paused, not shipping to the default region, or a store setting. It is not evidence of strong sales.', LIMIT_SALES],
    nextAction: 'Treat this as a prompt to look, not as demand. Deploi will not change your inventory.' })

  const gone = by('delisted')
  if (gone.length) out.push({ ...base('delisted'), basis: 'observed', meaningful: false,
    headline: `${plural(gone.length, 'product')} no longer listed at ${store.label}`,
    facts: ['Missing from the public feed in two consecutive complete checks.'], products: productsOf(store, gone), inference: null,
    limitations: ['It may be unpublished, removed or hidden from the feed. Failed or partial checks never count towards this.', LIMIT_SALES],
    nextAction: 'No action needed.' })

  const best = by('bestseller_entry')
  if (best.length) out.push({ ...base('bestseller_entries'), basis: 'observed', meaningful: prefs.bestsellers,
    headline: `${plural(best.length, 'product')} moved into the top of ${store.label}'s bestseller collection`,
    facts: [`Positions as displayed in the store's own bestseller collection.`, ...best.slice(0, 5).map(c => `${short(c.title)}: now position ${c.detail.rank}${typeof c.detail.previousRank === 'number' ? ` (was ${c.detail.previousRank})` : ' (not in the top before)'}.`)],
    products: productsOf(store, best, c => `position ${c.detail.rank}`),
    inference: 'A store places products in its own bestseller collection; the order may be automatic or chosen by hand.',
    limitations: ['The store decides this order. It is not a sales ranking Deploi can verify.', LIMIT_SALES],
    nextAction: 'Look at what these products have in common with your range.' })
  return out
}

/** A store that could not be read. Repeated failures of the same kind are reported once (same dedupe key). */
export function unavailableInsight(input: { store: StoreRef; status: string; reason: string; since: string; checkedAt: string }): InsightDraft {
  return {
    kind: 'source_unavailable', dedupeKey: `source_unavailable:${input.store.id}:${input.status}:${input.since}`, basis: 'unavailable', meaningful: false,
    headline: `${input.store.label} could not be checked`, facts: [input.reason], stores: [{ id: input.store.id, label: input.store.label }], products: [],
    sources: [{ url: input.store.origin, observedAt: input.checkedAt }], periodStart: input.since, periodEnd: input.checkedAt, inference: null,
    limitations: ['Nothing is inferred from a check that failed: no products are treated as removed, out of stock or new.'],
    nextAction: input.status === 'unsupported' ? 'This store does not publish a feed Deploi can read. Remove it, or keep it and check it by hand.' : 'Deploi will try again on the next scheduled check.',
  }
}

export type WindowLaunch = { storeId: string; store: string; externalId: string; title: string; url: string | null; productType: string; tags: string[]; observedAt: string; bestsellerRank: number | null; onBestsellerList: boolean }

/**
 * Patterns across followed stores: the same kind of product launched at several stores within the window.
 * Kinds come from the merchant's keywords and categories; without any, from the stores' product types.
 */
export function crossStorePatterns(input: { launches: WindowLaunch[]; keywords: string[]; categories: string[]; prefs: AlertPrefs; storesWatched: number; now: string }): InsightDraft[] {
  const terms = [...new Set([...input.keywords, ...input.categories].map(t => t.trim().toLowerCase()).filter(Boolean))]
  const groups = new Map<string, WindowLaunch[]>()
  for (const l of input.launches) {
    const text = productText(l)
    const keys = terms.length ? terms.filter(t => matchesKeyword(text, t)) : l.productType ? [l.productType] : []
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), l])
  }
  const out: InsightDraft[] = []
  const start = new Date(Date.parse(input.now) - input.prefs.windowDays * 864e5).toISOString()
  for (const [term, ls] of groups) {
    const stores = [...new Map(ls.map(l => [l.storeId, l.store])).entries()]
    if (stores.length < input.prefs.crossStoreMin) continue
    const featured = new Set(ls.filter(l => l.onBestsellerList).map(l => l.storeId)).size
    out.push({
      kind: 'cross_store_pattern', basis: 'inferred', meaningful: true,
      dedupeKey: `pattern:${hash(term)}:${hash(stores.map(s => s[0]).sort().join(','))}`,
      headline: `${stores.length} of the ${input.storesWatched} stores you follow added ${term} products in the last ${plural(input.prefs.windowDays, 'day')}`,
      facts: [
        `${plural(ls.length, 'new product')} matching "${term}" appeared at ${stores.map(s => s[1]).join(', ')}.`,
        featured ? `${plural(featured, 'store')} currently ${featured === 1 ? 'shows' : 'show'} one of them in ${featured === 1 ? 'its' : 'their'} own bestseller collection.` : 'None of them is in a store’s bestseller collection that Deploi can see.',
      ],
      stores: stores.map(([id, label]) => ({ id, label })),
      products: ls.slice(0, 50).map(l => ({ storeId: l.storeId, store: l.store, title: short(l.title, 120), url: l.url, observedAt: l.observedAt, note: l.onBestsellerList ? `in bestseller collection${l.bestsellerRank ? ` (position ${l.bestsellerRank})` : ''}` : undefined })),
      sources: ls.filter(l => l.url).slice(0, 12).map(l => ({ url: l.url!, observedAt: l.observedAt })),
      periodStart: start, periodEnd: input.now,
      inference: `Several stores you follow adding the same kind of product in a short time suggests they see an opportunity. This is an inference from launches, not a measure of demand.`,
      limitations: [`Only the ${input.storesWatched} stores you follow are counted; this is not a wider market trend (no market-wide data source is connected).`, 'Matching is by words in titles, types and tags and can include unrelated products.', LIMIT_SALES],
      nextAction: 'Worth investigating. Compare the products and, if they fit, turn this into a sourcing request draft for your Supplier Chaser.',
    })
  }
  return out
}
