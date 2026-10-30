/**
 * Turning observations into findings. Pure functions: no database, no network.
 *
 * Rules:
 *  - The first successful check of a store is its baseline. Nothing on it is called new; we only say
 *    how much was recorded. Later checks report changes against the previous observation.
 *  - Every finding is either "observed" (seen on a public page, with the page address and time) or an
 *    "inference" (Deploi's reading of several observations, for example similar products on several
 *    stores). Inferences say what they rest on and what we cannot know.
 *  - We never state or estimate sales, revenue, units sold, conversion or exact sales ranks. A public
 *    best-seller collection is the order the store chooses to display, and is described that way.
 */
import type { CompetitorAlert, CompetitorPolicy } from '../agents/policy'
import type { PublicProduct, StoreSnapshot } from './collect'

export type FindingKind = 'baseline' | 'new_product' | 'price_drop' | 'price_rise' | 'discount_started' | 'discount_ended' | 'back_in_stock' | 'sold_out'
  | 'no_longer_listed' | 'bestseller_entered' | 'bestseller_moved' | 'bestseller_left' | 'featured' | 'cross_store' | 'opportunity'
export type Evidence = { url: string; observedAt: string; what: string; before?: string | number | boolean | null; after?: string | number | boolean | null; beforeObservedAt?: string; store?: string }
export type Finding = { kind: FindingKind; basis: 'observed' | 'inference'; title: string; summary: string; productKey: string | null; evidence: Evidence[]; dedupeKey: string; sourceId: string | null }

export type StoredProduct = PublicProduct & { bestsellerList: string | null; bestsellerPosition: number | null; featuredIn: string[]; listed: boolean; firstSeenAt: string; lastSeenAt: string }

export const ALERT_OF: Record<Exclude<FindingKind, 'baseline'>, CompetitorAlert> = {
  new_product: 'launches', no_longer_listed: 'launches',
  price_drop: 'price_changes', price_rise: 'price_changes',
  discount_started: 'discounts', discount_ended: 'discounts',
  back_in_stock: 'availability', sold_out: 'availability',
  bestseller_entered: 'bestsellers', bestseller_moved: 'bestsellers', bestseller_left: 'bestsellers',
  featured: 'featured', cross_store: 'trends', opportunity: 'trends',
}

export const when = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` }
const money = (n: number | null) => (n === null ? 'no price shown' : n.toFixed(2))
const pct = (a: number, b: number) => Math.round(((b - a) / a) * 1000) / 10

/** Does a product fall inside the merchant's keywords (name, type or tags)? No keywords = every product. */
export function matchesKeywords(p: Pick<PublicProduct, 'title' | 'productType' | 'tags'>, keywords: string[]): boolean {
  if (!keywords.length) return true
  const hay = [p.title, p.productType ?? '', ...p.tags].join(' ').toLowerCase()
  return keywords.some(k => hay.includes(k))
}

export type CompareInput = {
  sourceId: string; host: string
  prev: Map<string, StoredProduct>
  /** when the previous successful check happened; null = this is the baseline */
  prevObservedAt: string | null
  snapshot: StoreSnapshot
  prefs: Pick<CompetitorPolicy, 'alerts' | 'minPriceChangePct' | 'keywords'>
}

export function compareStore(input: CompareInput): { findings: Finding[]; next: StoredProduct[]; newKeys: Set<string> } {
  const { snapshot: s, prev, prefs, sourceId, host } = input
  const at = s.observedAt
  const inScope = s.products.filter(p => matchesKeywords(p, prefs.keywords))
  const bsPos = new Map<string, number>((s.bestsellers?.keys ?? []).map((k, i) => [k, i + 1]))
  const featuredBy = new Map<string, string[]>()
  for (const l of s.featured) for (const k of l.keys) featuredBy.set(k, [...(featuredBy.get(k) ?? []), l.title])
  const next: StoredProduct[] = inScope.map(p => {
    const old = prev.get(p.key)
    return { ...p, bestsellerList: bsPos.has(p.key) ? s.bestsellers!.title : null, bestsellerPosition: bsPos.get(p.key) ?? null, featuredIn: featuredBy.get(p.key) ?? [],
      listed: true, firstSeenAt: old?.firstSeenAt ?? at, lastSeenAt: at }
  })
  const findings: Finding[] = []
  const newKeys = new Set<string>()
  const on = (k: Exclude<FindingKind, 'baseline'>) => prefs.alerts.includes(ALERT_OF[k])
  const push = (f: Omit<Finding, 'sourceId'>) => { if (f.kind === 'baseline' || on(f.kind as Exclude<FindingKind, 'baseline'>)) findings.push({ ...f, sourceId }) }

  if (input.prevObservedAt === null) {
    const bs = s.bestsellers
    push({ kind: 'baseline', basis: 'observed', productKey: null, dedupeKey: `baseline:${sourceId}`,
      title: `Starting point recorded for ${host}`,
      summary: `${next.length} product${next.length === 1 ? '' : 's'}${prefs.keywords.length ? ' matching your keywords' : ''} recorded on ${when(at)}${s.complete ? '' : ' (the first 1,000 the store lists)'}${bs ? `, plus the store's public "${bs.title}" collection` : ''}${s.featured.length ? ` and ${s.featured.map(f => `"${f.title}"`).join(', ')}` : ''}. These are not new launches: changes are reported from the next check.`,
      evidence: [{ url: `https://${host}/products.json`, observedAt: at, what: 'public product feed', after: next.length }, ...(bs ? [{ url: bs.url, observedAt: at, what: 'public best-seller collection', after: bs.keys.length }] : [])] })
    return { findings, next, newKeys }
  }

  const before = input.prevObservedAt
  for (const p of next) {
    const o = prev.get(p.key)
    const ev = (what: string, b: Evidence['before'], a: Evidence['after']): Evidence => ({ url: p.url, observedAt: at, what, before: b, after: a, beforeObservedAt: before })
    if (!o || !o.listed) {
      newKeys.add(p.key)
      const pub = p.publishedAt ? ` The store's public feed gives a publish date of ${when(p.publishedAt)}.` : ''
      push({ kind: 'new_product', basis: 'observed', productKey: p.key, dedupeKey: `new_product:${sourceId}:${p.key}:${o ? o.lastSeenAt : 'first'}`,
        title: `New on ${host}: ${p.title}`,
        summary: `${o ? 'Listed again' : 'First seen'} on ${when(at)}, at ${money(p.price)}${p.compareAt ? ` (shown reduced from ${money(p.compareAt)})` : ''}. It was not listed at the previous check (${when(before)}).${pub}`,
        evidence: [ev('product listed', 'not listed', p.title)] })
      if (p.featuredIn.length) push({ kind: 'featured', basis: 'observed', productKey: p.key, dedupeKey: `featured:${sourceId}:${p.key}:${p.featuredIn.sort().join('|')}`,
        title: `Featured on ${host}: ${p.title}`, summary: `Shown in the store's public ${p.featuredIn.map(x => `"${x}"`).join(' and ')} collection${p.featuredIn.length > 1 ? 's' : ''} on ${when(at)}.`,
        evidence: [ev('featured collection', null, p.featuredIn.join(', '))] })
      if (p.bestsellerPosition) push({ kind: 'bestseller_entered', basis: 'observed', productKey: p.key, dedupeKey: `bestseller_entered:${sourceId}:${p.key}:${at.slice(0, 10)}`,
        title: `In ${host}'s best-seller list: ${p.title}`, summary: `Shown at position ${p.bestsellerPosition} in the store's public "${p.bestsellerList}" collection on ${when(at)}. This is the order the store chose to show, not a sales figure.`,
        evidence: [ev('best-seller position', null, p.bestsellerPosition)] })
      continue
    }
    // a reduction advertised against the old price is reported once, as a discount, not also as a price drop
    const advertisedFromOld = p.compareAt !== null && !o.compareAt && o.price !== null && Math.abs(p.compareAt - o.price) < 0.005
    if (o.price !== null && p.price !== null && o.price > 0 && o.price !== p.price && !advertisedFromOld) {
      const change = pct(o.price, p.price)
      if (Math.abs(change) >= prefs.minPriceChangePct) push({ kind: change < 0 ? 'price_drop' : 'price_rise', basis: 'observed', productKey: p.key, dedupeKey: `price:${sourceId}:${p.key}:${p.price.toFixed(2)}:${o.price.toFixed(2)}`,
        title: `Price ${change < 0 ? 'down' : 'up'} ${Math.abs(change)}% on ${host}: ${p.title}`,
        summary: `${money(o.price)} on ${when(o.lastSeenAt)}, ${money(p.price)} on ${when(at)} (lowest variant price, in the store's own currency).`,
        evidence: [{ ...ev('price', o.price, p.price), beforeObservedAt: o.lastSeenAt }] })
    }
    if (p.compareAt && !o.compareAt) push({ kind: 'discount_started', basis: 'observed', productKey: p.key, dedupeKey: `discount_started:${sourceId}:${p.key}:${p.compareAt}:${p.price}`,
      title: `Discount advertised on ${host}: ${p.title}`,
      summary: `Shown as reduced from ${money(p.compareAt)} to ${money(p.price)}${p.price ? ` (${Math.abs(pct(p.compareAt, p.price))}% off as advertised)` : ''} on ${when(at)}. No reduction was shown on ${when(o.lastSeenAt)}.`,
      evidence: [{ ...ev('compare-at price', o.compareAt, p.compareAt), beforeObservedAt: o.lastSeenAt }] })
    if (!p.compareAt && o.compareAt) push({ kind: 'discount_ended', basis: 'observed', productKey: p.key, dedupeKey: `discount_ended:${sourceId}:${p.key}:${at.slice(0, 10)}`,
      title: `Discount no longer shown on ${host}: ${p.title}`, summary: `Shown reduced from ${money(o.compareAt)} on ${when(o.lastSeenAt)}; no reduction shown on ${when(at)} (now ${money(p.price)}).`,
      evidence: [{ ...ev('compare-at price', o.compareAt, null), beforeObservedAt: o.lastSeenAt }] })
    if (o.available !== null && p.available !== null && o.available !== p.available) push({ kind: p.available ? 'back_in_stock' : 'sold_out', basis: 'observed', productKey: p.key,
      dedupeKey: `availability:${sourceId}:${p.key}:${p.available}:${at.slice(0, 10)}`,
      title: `${p.available ? 'Back in stock' : 'Sold out'} on ${host}: ${p.title}`,
      summary: `The store showed it as ${o.available ? 'available' : 'unavailable'} on ${when(o.lastSeenAt)} and ${p.available ? 'available' : 'unavailable'} on ${when(at)}. Deploi cannot see how many units they have.`,
      evidence: [{ ...ev('available to buy', o.available, p.available), beforeObservedAt: o.lastSeenAt }] })
    if (s.bestsellers) {
      if (p.bestsellerPosition && !o.bestsellerPosition) push({ kind: 'bestseller_entered', basis: 'observed', productKey: p.key, dedupeKey: `bestseller_entered:${sourceId}:${p.key}:${at.slice(0, 10)}`,
        title: `Now in ${host}'s best-seller list: ${p.title}`, summary: `Shown at position ${p.bestsellerPosition} in the store's public "${p.bestsellerList}" collection on ${when(at)}; not in it on ${when(o.lastSeenAt)}. This is the order the store chose to show, not a sales figure.`,
        evidence: [{ ...ev('best-seller position', null, p.bestsellerPosition), beforeObservedAt: o.lastSeenAt }] })
      else if (!p.bestsellerPosition && o.bestsellerPosition) push({ kind: 'bestseller_left', basis: 'observed', productKey: p.key, dedupeKey: `bestseller_left:${sourceId}:${p.key}:${at.slice(0, 10)}`,
        title: `Left ${host}'s best-seller list: ${p.title}`, summary: `At position ${o.bestsellerPosition} on ${when(o.lastSeenAt)}; not in the public "${o.bestsellerList ?? s.bestsellers.title}" collection on ${when(at)}.`,
        evidence: [{ ...ev('best-seller position', o.bestsellerPosition, null), beforeObservedAt: o.lastSeenAt }] })
      else if (p.bestsellerPosition && o.bestsellerPosition && Math.abs(p.bestsellerPosition - o.bestsellerPosition) >= 2) push({ kind: 'bestseller_moved', basis: 'observed', productKey: p.key,
        dedupeKey: `bestseller_moved:${sourceId}:${p.key}:${o.bestsellerPosition}:${p.bestsellerPosition}`,
        title: `${p.bestsellerPosition < o.bestsellerPosition ? 'Up' : 'Down'} in ${host}'s best-seller list: ${p.title}`,
        summary: `Position ${o.bestsellerPosition} on ${when(o.lastSeenAt)}, position ${p.bestsellerPosition} on ${when(at)} in the store's public "${p.bestsellerList}" collection. The store sets this order; it is not a measured sales rank.`,
        evidence: [{ ...ev('best-seller position', o.bestsellerPosition, p.bestsellerPosition), beforeObservedAt: o.lastSeenAt }] })
    }
    const newly = p.featuredIn.filter(x => !o.featuredIn.includes(x))
    if (newly.length) push({ kind: 'featured', basis: 'observed', productKey: p.key, dedupeKey: `featured:${sourceId}:${p.key}:${newly.sort().join('|')}:${at.slice(0, 10)}`,
      title: `Newly featured on ${host}: ${p.title}`, summary: `Shown in the store's public ${newly.map(x => `"${x}"`).join(' and ')} collection on ${when(at)}; not there on ${when(o.lastSeenAt)}.`,
      evidence: [{ ...ev('featured collection', o.featuredIn.join(', ') || null, p.featuredIn.join(', ')), beforeObservedAt: o.lastSeenAt }] })
  }
  // products we saw before and no longer see: only claimed when we read the whole feed this time
  const kept: StoredProduct[] = []
  if (s.complete) {
    const seen = new Set(next.map(p => p.key))
    for (const o of prev.values()) {
      if (seen.has(o.key) || !o.listed || !matchesKeywords(o, prefs.keywords)) continue
      push({ kind: 'no_longer_listed', basis: 'observed', productKey: o.key, dedupeKey: `no_longer_listed:${sourceId}:${o.key}:${o.lastSeenAt}`,
        title: `No longer listed on ${host}: ${o.title}`, summary: `Listed on ${when(o.lastSeenAt)}; not in the store's public product feed on ${when(at)}. It may have been removed, hidden or renamed.`,
        evidence: [{ url: o.url, observedAt: at, what: 'product listed', before: o.title, after: 'not listed', beforeObservedAt: o.lastSeenAt }] })
      kept.push({ ...o, listed: false, bestsellerPosition: null, bestsellerList: null, featuredIn: [] })
    }
  }
  return { findings, next: [...next, ...kept], newKeys }
}

// ------------------------------------------------------------------ similar products across stores

const STOP = new Set(['the', 'and', 'with', 'for', 'of', 'a', 'an', 'in', 'on', 'by', 'to', 'set', 'pack', 'piece', 'pcs', 'new', 'x', 'small', 'medium', 'large', 'xl', 'mini', 'classic', 'premium', 'handmade'])
/** Words that describe what a product is, for comparing names across stores. */
export function nameTokens(title: string): string[] {
  return [...new Set(title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(w => (w.length > 4 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))]
}
/** Two names describe the same kind of product: at least two shared words, covering most of the shorter name. */
export function similarNames(a: string, b: string): boolean {
  const x = nameTokens(a), y = new Set(nameTokens(b))
  const shared = x.filter(w => y.has(w)).length
  return shared >= 2 && shared / Math.min(x.length, y.size) >= 0.6
}

export type StoreProducts = { sourceId: string; host: string; products: StoredProduct[]; newKeys: Set<string>; observedAt: string }

function signals(p: StoredProduct, isNew: boolean): string[] {
  return [
    ...(isNew ? [`new since the previous check`] : []),
    ...(p.bestsellerPosition ? [`position ${p.bestsellerPosition} in the public "${p.bestsellerList}" collection`] : []),
    ...p.featuredIn.map(f => `featured in "${f}"`),
    ...(p.compareAt && p.price ? [`advertised reduced from ${money(p.compareAt)} to ${money(p.price)}`] : []),
  ]
}

/**
 * Similar products on two or more monitored stores where at least one is notable (new since the
 * previous check, in a public best-seller collection, or featured). Each is an inference with the
 * listings it rests on. With your own catalog's product names, a cluster you do not appear to sell
 * and that two or more stores highlight becomes a possible opportunity.
 */
export function crossStore(stores: StoreProducts[], opts: { ownTitles: string[] | null; alerts: CompetitorAlert[]; observedAt: string }): Finding[] {
  if (!opts.alerts.includes('trends')) return []
  type Item = { store: StoreProducts; p: StoredProduct; notable: boolean }
  const items: Item[] = stores.flatMap(st => st.products.filter(p => p.listed).map(p => ({ store: st, p, notable: st.newKeys.has(p.key) || p.bestsellerPosition !== null || p.featuredIn.length > 0 })))
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]
    if (a.store.sourceId === b.store.sourceId || !(a.notable || b.notable)) continue
    if (similarNames(a.p.title, b.p.title)) parent[find(i)] = find(j)
  }
  const groups = new Map<number, Item[]>()
  items.forEach((it, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), it]) })
  const out: Finding[] = []
  for (const g of groups.values()) {
    const hosts = [...new Set(g.map(x => x.store.host))]
    const notable = g.filter(x => x.notable)
    if (hosts.length < 2 || !notable.length) continue
    // the theme: the words most of these product names share
    const counts = new Map<string, number>()
    for (const x of g) for (const w of nameTokens(x.p.title)) counts.set(w, (counts.get(w) ?? 0) + 1)
    const theme = [...counts.entries()].filter(([, n]) => n >= Math.ceil(g.length / 2)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => w).sort()
    const label = theme.join(' ') || nameTokens(g[0].p.title).slice(0, 2).join(' ')
    const evidence: Evidence[] = g.slice(0, 12).map(x => ({ url: x.p.url, observedAt: x.p.lastSeenAt, store: x.store.host, what: x.p.title,
      after: [`${money(x.p.price)}`, ...signals(x.p, x.store.newKeys.has(x.p.key))].join('; ') }))
    const list = hosts.map(h => { const xs = g.filter(x => x.store.host === h); return `${h} (${xs.map(x => `"${x.p.title}"`).join(', ')})` }).join('; ')
    const sig = notable.map(x => signals(x.p, x.store.newKeys.has(x.p.key)).length).reduce((a, b) => a + b, 0)
    out.push({ kind: 'cross_store', basis: 'inference', productKey: null, sourceId: null, dedupeKey: `cross_store:${label}:${hosts.length}`,
      title: `Similar products on ${hosts.length} stores: ${label}`,
      summary: `Inference from public listings: ${list}. ${notable.length} of these ${notable.length === 1 ? 'is' : 'are'} new, featured or in a public best-seller collection. Deploi matched them by product name; it cannot see how many any store sells.`,
      evidence })
    if (opts.ownTitles && sig >= 2) {
      const yours = opts.ownTitles.find(t => g.some(x => similarNames(t, x.p.title)))
      if (!yours) out.push({ kind: 'opportunity', basis: 'inference', productKey: null, sourceId: null, dedupeKey: `opportunity:${label}:${hosts.length}`,
        title: `Possible opportunity: ${label}`,
        summary: `${hosts.length} monitored stores list similar products (${list}), with ${sig} public signal${sig === 1 ? '' : 's'} between them (new, featured, best-seller collection or advertised discount). Your catalog has no product with a similar name. This is a lead to research, not a forecast: public listings do not show sales, revenue or demand.`,
        evidence })
    }
  }
  return out
}
