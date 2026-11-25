import type { ShopifyVariantRecord, ShopifyLevel } from './types'

type Count = number | { count?: number } | null | undefined
const countOf = (c: Count) => (typeof c === 'number' ? c : typeof c?.count === 'number' ? c.count : 0)

export type GqlVariant = {
  id: string; title: string; sku: string | null; inventoryPolicy: string
  price?: string | null; compareAtPrice?: string | null; barcodes?: { nodes: { value: string }[] }
  sellingPlanGroupsCount?: Count
  product: { id: string; title: string; handle?: string | null; status: string; tags: string[]; isGiftCard?: boolean; requiresSellingPlan?: boolean; sellingPlanGroupsCount?: Count; updatedAt?: string; onlineStoreUrl?: string | null
    resourcePublicationsV2?: { pageInfo?: { hasNextPage?: boolean }; nodes: { publication: { id: string }; isPublished: boolean; publishDate?: string | null }[] } }
  inventoryItem: { id: string; tracked: boolean; duplicateSkuCount?: number | null; inventoryLevels?: { pageInfo?: { hasNextPage?: boolean }; nodes: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] }[] } } | null
}

/** Shopify returns decimal strings; normalise to two places without floating point. */
export function money(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(String(v).trim())
  if (!m) return String(v)
  const frac = (m[2] ?? '').padEnd(2, '0')
  return frac.length > 2 && /^0+$/.test(frac.slice(2)) ? `${m[1]}.${frac.slice(0, 2)}` : `${m[1]}.${frac}`
}

export function normalizeVariant(v: GqlVariant, fetchedAt: string, now = new Date(fetchedAt)): ShopifyVariantRecord {
  const levels: ShopifyLevel[] = (v.inventoryItem?.inventoryLevels?.nodes ?? []).map(n => {
    const q = (name: string) => { const x = n.quantities.find(y => y.name === name); return typeof x?.quantity === 'number' ? x.quantity : null }
    return { locationId: n.location.id, locationName: n.location.name, available: q('available'), onHand: q('on_hand'), committed: q('committed') }
  })
  const readable = levels.filter(l => typeof l.available === 'number')
  return {
    resourceType: 'variant',
    resourceId: v.id,
    fetchedAt,
    variantId: v.id,
    variantTitle: v.title,
    sku: v.sku || null,
    inventoryPolicy: v.inventoryPolicy,
    productId: v.product.id,
    productTitle: v.product.title,
    productHandle: v.product.handle ?? null,
    productStatus: v.product.status,
    productTags: v.product.tags ?? [],
    isGiftCard: Boolean(v.product.isGiftCard),
    sellingPlanGroupsCount: countOf(v.sellingPlanGroupsCount) + countOf(v.product.sellingPlanGroupsCount),
    requiresSellingPlan: Boolean(v.product.requiresSellingPlan),
    tracked: Boolean(v.inventoryItem?.tracked),
    inventoryItemId: v.inventoryItem?.id ?? null,
    levels,
    totalAvailable: readable.length ? readable.reduce((s, l) => s + (l.available as number), 0) : null,
    levelsComplete: !v.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage,
    price: money(v.price),
    compareAtPrice: money(v.compareAtPrice),
    barcodes: (v.barcodes?.nodes ?? []).map(b => b.value).filter(Boolean),
    duplicateSkuCount: typeof v.inventoryItem?.duplicateSkuCount === 'number' ? v.inventoryItem.duplicateSkuCount : null,
    ...publication(v, now),
    onlineStoreUrl: v.product.onlineStoreUrl ?? null,
  }
}

function publication(v: GqlVariant, now: Date): { published: Record<string, boolean>; scheduledOn: string[]; publicationsComplete?: boolean } {
  const published: Record<string, boolean> = {}
  const scheduledOn: string[] = []
  const rp = v.product.resourcePublicationsV2
  for (const n of rp?.nodes ?? []) {
    const future = n.publishDate ? new Date(n.publishDate).getTime() > now.getTime() : false
    published[n.publication.id] = n.isPublished && !future
    if (future) scheduledOn.push(n.publication.id)
  }
  // complete when Shopify says there is no next page, or (no pageInfo) when fewer nodes came back than were asked for
  if (!rp) return { published, scheduledOn }
  const complete = rp.pageInfo ? rp.pageInfo.hasNextPage === false : rp.nodes.length < 10
  return { published, scheduledOn, publicationsComplete: complete }
}

/**
 * Unpublishing may remove the channel from resourcePublicationsV2 instead of returning isPublished: false
 * (unverified on a live store). When the product's publication list was read in full, every known channel
 * that is absent is recorded as not published, so verification of an unpublish reads "false", not "missing".
 */
export function fillAbsentPublications<T extends { published: Record<string, boolean>; publicationsComplete?: boolean }>(r: T, knownPublicationIds: readonly string[]): T {
  if (!r.publicationsComplete) return r
  for (const id of knownPublicationIds) if (!(id in r.published)) r.published[id] = false
  return r
}
