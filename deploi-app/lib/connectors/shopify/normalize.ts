import type { ShopifyVariantRecord, ShopifyLevel } from './types'

type Count = number | { count?: number } | null | undefined
const countOf = (c: Count) => (typeof c === 'number' ? c : typeof c?.count === 'number' ? c.count : 0)

export type GqlVariant = {
  id: string; title: string; sku: string | null; inventoryPolicy: string
  sellingPlanGroupsCount?: Count
  product: { id: string; title: string; handle?: string | null; status: string; tags: string[]; isGiftCard?: boolean; requiresSellingPlan?: boolean; sellingPlanGroupsCount?: Count; updatedAt?: string }
  inventoryItem: { id: string; tracked: boolean; inventoryLevels?: { pageInfo?: { hasNextPage?: boolean }; nodes: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] }[] } } | null
}

export function normalizeVariant(v: GqlVariant, fetchedAt: string): ShopifyVariantRecord {
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
  }
}
