import type { ResourceRecord } from '../../engine/types'

export type ShopifyLevel = { locationId: string; locationName: string; available: number | null; onHand: number | null; committed: number | null }

/** One product variant as read from the Admin GraphQL API, normalised. */
export type ShopifyVariantRecord = ResourceRecord & {
  resourceType: 'variant'
  variantId: string
  variantTitle: string
  sku: string | null
  inventoryPolicy: 'CONTINUE' | 'DENY' | string
  productId: string
  productTitle: string
  productHandle: string | null
  productStatus: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED' | string
  productTags: string[]
  isGiftCard: boolean
  /** selling plan groups attached to the variant or its product (pre-order and subscription apps use these) */
  sellingPlanGroupsCount: number
  requiresSellingPlan: boolean
  tracked: boolean
  inventoryItemId: string | null
  levels: ShopifyLevel[]
  /** sum of `available` over the locations read; null when no quantity could be read */
  totalAvailable: number | null
  /** false when the record has more inventory levels than were read */
  levelsComplete: boolean
}
