/**
 * Competitor & Trend Watcher: shared types. Everything here describes what was publicly OBSERVED on a
 * store's own pages at a moment in time. Nothing describes sales: a public feed shows what a store lists,
 * prices and marks available, never what it sold.
 */

/** How an insight is supported. */
export type Basis = 'observed' | 'inferred' | 'unavailable'

export type ObservedVariant = { id: string; title: string; price: number | null; compareAt: number | null; available: boolean | null }

export type ObservedProduct = {
  externalId: string
  handle: string
  title: string
  productType: string
  vendor: string
  tags: string[]
  /** as published by the store in its feed (ISO), not verified */
  publishedAt: string | null
  createdAt: string | null
  url: string
  variants: ObservedVariant[]
}

export type BestsellerObservation =
  | { status: 'observed'; handle: string; url: string; ranked: string[] /* externalIds in displayed order */ }
  | { status: 'unavailable'; reason: string }

/** One check of one store. */
export type StoreSnapshot = {
  fetchedAt: Date
  /** ISO 4217 from the store's own metadata, or null when it did not say */
  currency: string | null
  storeName: string | null
  /** true only when every page of the feed was read; a partial read never implies anything is missing */
  complete: boolean
  incompleteReason: string | null
  products: ObservedProduct[]
  bestseller: BestsellerObservation
  requestsUsed: number
  sourceUrls: string[]
}

export type SourceStatus = 'supported' | 'unsupported' | 'blocked' | 'rate_limited' | 'error'

export type CollectResult =
  | { ok: true; snapshot: StoreSnapshot; status: 'supported' }
  | { ok: false; status: Exclude<SourceStatus, 'supported'>; reason: string; requestsUsed: number }

export type CollectBudget = { maxRequests: number; maxProducts: number; delayMs: number }

/** A source of public competitor observations. */
export interface CompetitorSource {
  key: string
  label: string
  /** what this source can and cannot see, shown to the merchant */
  coverage: string[]
  collect(input: { origin: string; bestsellerHandle: string | null; budget: CollectBudget }): Promise<CollectResult>
}

/** What Deploi already knows about one product of one watched store. */
export type KnownProduct = {
  externalId: string
  title: string
  url: string
  productType: string
  tags: string[]
  publishedAt: string | null
  firstSeenAt: string
  /** first recorded in the store's baseline check (never reported as a launch) */
  inBaseline: boolean
  /** currently in the feed as far as Deploi knows */
  listed: boolean
  /** consecutive complete checks that did not include it */
  missingStreak: number
  currency: string | null
  variants: ObservedVariant[]
  bestsellerRank: number | null
}

export type KnownStore = {
  /** time of the first complete check (null until one succeeds) */
  baselineAt: string | null
  /** whether the previous successful check read every page */
  lastCheckComplete: boolean
  /** whether the store's bestseller list was observed in the previous successful check */
  bestsellerObservedBefore: boolean
  products: Map<string, KnownProduct>
}

export type ChangeKind = 'baseline' | 'launch' | 'newly_observed' | 'price_change' | 'promotion_started' | 'promotion_ended' | 'became_unavailable' | 'became_available' | 'delisted' | 'bestseller_entry'

export type Change = {
  kind: ChangeKind
  externalId: string | null
  title: string | null
  url: string | null
  observedAt: string
  detail: Record<string, unknown>
}
