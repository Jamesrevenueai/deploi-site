/**
 * Compare a new check of a store with what Deploi already knew. Pure: no I/O.
 *
 * The rules that keep this honest:
 *  - The first complete check is the BASELINE. Everything in it is recorded, nothing in it is "new".
 *  - A product counts as a LAUNCH only when the store's own published date is after the baseline. A product
 *    we simply had not seen before (published earlier) is "newly observed", and only after a complete check.
 *  - A product missing from a check is never assumed removed. "No longer listed" needs two consecutive
 *    COMPLETE checks without it. Partial or failed checks change nothing about missing products.
 *  - Price changes compare the same variant, in the same currency, between two real observations. A price
 *    we could not read is null and is never compared.
 *  - "Shown as unavailable" is what the feed said, not a stockout and not evidence of sales.
 *  - A bestseller entry needs the bestseller list observed in both checks.
 */
import type { Change, KnownProduct, KnownStore, ObservedProduct, StoreSnapshot } from './types'

export type DiffOptions = { bestsellerTopN: number }
export type DiffResult = { changes: Change[]; products: Map<string, KnownProduct>; baselineAt: string | null; bestsellerObserved: boolean }

const pct = (from: number, to: number) => (from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10)
const onSale = (v: { price: number | null; compareAt: number | null }) => v.price !== null && v.compareAt !== null && v.compareAt > v.price

function knownFrom(p: ObservedProduct, at: string, inBaseline: boolean, currency: string | null, rank: number | null): KnownProduct {
  return { externalId: p.externalId, title: p.title, url: p.url, productType: p.productType, tags: p.tags, publishedAt: p.publishedAt, firstSeenAt: at, inBaseline, listed: true, missingStreak: 0, currency, variants: p.variants, bestsellerRank: rank }
}

export function diffSnapshot(known: KnownStore, snap: StoreSnapshot, opts: DiffOptions = { bestsellerTopN: 10 }): DiffResult {
  const at = snap.fetchedAt.toISOString()
  const changes: Change[] = []
  const products = new Map(known.products)
  const ranks = new Map<string, number>()
  if (snap.bestseller.status === 'observed') snap.bestseller.ranked.forEach((id, i) => { if (!ranks.has(id)) ranks.set(id, i + 1) })
  const rankOf = (id: string) => ranks.get(id) ?? null
  const bestsellerComparable = snap.bestseller.status === 'observed' && known.bestsellerObservedBefore

  // ---- baseline: the first complete check records everything and reports nothing as new
  if (!known.baselineAt) {
    for (const p of snap.products) products.set(p.externalId, knownFrom(p, at, snap.complete, snap.currency, rankOf(p.externalId)))
    if (!snap.complete) return { changes: [], products, baselineAt: null, bestsellerObserved: snap.bestseller.status === 'observed' }
    changes.push({ kind: 'baseline', externalId: null, title: null, url: null, observedAt: at, detail: { products: snap.products.length, currency: snap.currency, bestseller: snap.bestseller.status } })
    return { changes, products, baselineAt: at, bestsellerObserved: snap.bestseller.status === 'observed' }
  }
  const baselineMs = Date.parse(known.baselineAt)

  const present = new Set<string>()
  for (const p of snap.products) {
    present.add(p.externalId)
    const prev = known.products.get(p.externalId)
    const rank = rankOf(p.externalId)
    if (!prev) {
      const published = p.publishedAt ? Date.parse(p.publishedAt) : NaN
      if (!Number.isNaN(published) && published > baselineMs) {
        changes.push({ kind: 'launch', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { publishedAt: p.publishedAt, productType: p.productType, tags: p.tags, currency: snap.currency, priceMin: p.variants.some(v => v.price !== null) ? Math.min(...p.variants.map(v => v.price ?? Infinity)) : null, bestsellerRank: rank } })
      } else if (snap.complete && known.lastCheckComplete) {
        changes.push({ kind: 'newly_observed', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { publishedAt: p.publishedAt, note: 'first seen now; the store dates it before monitoring began, so it may have been unpublished or outside earlier checks' } })
      }
      products.set(p.externalId, knownFrom(p, at, false, snap.currency, rank))
      continue
    }
    // same product: compare variants in the same currency only
    const sameCurrency = prev.currency !== null && snap.currency !== null && prev.currency === snap.currency
    const before = new Map(prev.variants.map(v => [v.id, v]))
    for (const v of p.variants) {
      const b = before.get(v.id)
      if (!b) continue
      if (sameCurrency && b.price !== null && v.price !== null && b.price !== v.price) {
        changes.push({ kind: 'price_change', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { variantId: v.id, variant: v.title, from: b.price, to: v.price, pct: pct(b.price, v.price), currency: snap.currency } })
      }
      if (b.price !== null && v.price !== null) {
        if (!onSale(b) && onSale(v)) changes.push({ kind: 'promotion_started', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { variantId: v.id, variant: v.title, price: v.price, compareAt: v.compareAt, currency: snap.currency } })
        else if (onSale(b) && !onSale(v)) changes.push({ kind: 'promotion_ended', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { variantId: v.id, variant: v.title, price: v.price, currency: snap.currency } })
      }
      if (b.available !== null && v.available !== null && b.available !== v.available) {
        changes.push({ kind: v.available ? 'became_available' : 'became_unavailable', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { variantId: v.id, variant: v.title } })
      }
    }
    if (bestsellerComparable && rank !== null && rank <= opts.bestsellerTopN && (prev.bestsellerRank === null || prev.bestsellerRank > opts.bestsellerTopN)) {
      changes.push({ kind: 'bestseller_entry', externalId: p.externalId, title: p.title, url: p.url, observedAt: at, detail: { rank, previousRank: prev.bestsellerRank, collection: snap.bestseller.status === 'observed' ? snap.bestseller.url : null } })
    }
    products.set(p.externalId, { ...prev, title: p.title, url: p.url, productType: p.productType, tags: p.tags, publishedAt: p.publishedAt ?? prev.publishedAt, listed: true, missingStreak: 0, currency: snap.currency ?? prev.currency, variants: p.variants,
      // a rank is only replaced by a fresh observation of the list; an unread list keeps the last known rank
      bestsellerRank: snap.bestseller.status === 'observed' ? rank : prev.bestsellerRank })
  }

  // ---- missing products: only complete checks count, and it takes two in a row
  if (snap.complete) {
    for (const [id, prev] of known.products) {
      if (present.has(id) || !prev.listed) continue
      const streak = prev.missingStreak + 1
      if (streak >= 2) {
        changes.push({ kind: 'delisted', externalId: id, title: prev.title, url: prev.url, observedAt: at, detail: { checksMissing: streak, note: 'not in the public feed in two consecutive complete checks; it may be unpublished, removed or hidden from the feed' } })
        products.set(id, { ...prev, listed: false, missingStreak: streak })
      } else products.set(id, { ...prev, missingStreak: streak })
    }
  }
  return { changes, products, baselineAt: known.baselineAt, bestsellerObserved: snap.bestseller.status === 'observed' }
}
