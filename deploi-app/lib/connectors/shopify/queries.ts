/**
 * The Admin GraphQL documents this app sends (Admin API 2026-10; see docs/platform-research/shopify.md).
 * Query cost is not documented for this selection: measure extensions.cost on a development store.
 * The Admin GraphQL documents this app sends. Operation names are stable: the synthetic store
 * dispatches on them, and they make requests easy to find in logs.
 */
/** The variant fields read on every scan. Publication fields need `read_publications`, which is optional, so they are included only when it is granted. */
export const variantFields = (withPublications: boolean) => /* GraphQL */ `
  fragment DeploiVariantFields on ProductVariant {
    id
    title
    sku
    price
    compareAtPrice
    barcodes(first: 20) { nodes { value } }
    inventoryPolicy
    sellingPlanGroupsCount { count }
    product {
      id
      title
      handle
      status
      tags
      isGiftCard
      requiresSellingPlan
      sellingPlanGroupsCount { count }
      onlineStoreUrl
      updatedAt
      ${withPublications ? 'resourcePublicationsV2(first: 10, onlyPublished: false) { nodes { publication { id } isPublished publishDate } }' : ''}
    }
    inventoryItem {
      id
      tracked
      duplicateSkuCount
      inventoryLevels(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          location { id name }
          quantities(names: ["available", "on_hand", "committed"]) { name quantity }
        }
      }
    }
  }
`
export const VARIANT_FIELDS = variantFields(true)
const VARIANT_FIELDS_NO_PUBLICATIONS = variantFields(false)

/** The document to send for this connection: without publication fields unless `read_publications` is granted. */
export function docFor(doc: string, scopes: string[]): string {
  return scopes.includes('read_publications') ? doc : doc.split(VARIANT_FIELDS).join(VARIANT_FIELDS_NO_PUBLICATIONS)
}

/** What the store has granted this app (the source of truth for store_connections.scopes, with app/scopes_update). */
export const Q_ACCESS_SCOPES = /* GraphQL */ `
  query DeploiAccessScopes {
    currentAppInstallation { accessScopes { handle } }
  }
`

export const Q_SHOP = /* GraphQL */ `
  query DeploiShop {
    shop { name myshopifyDomain ianaTimezone currencyCode }
  }
`

export const Q_VARIANTS = /* GraphQL */ `
  query DeploiVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ...DeploiVariantFields }
    }
  }
  ${VARIANT_FIELDS}
`

export const Q_NODES = /* GraphQL */ `
  query DeploiNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant { ...DeploiVariantFields }
      ... on Product { id variants(first: 100) { nodes { ...DeploiVariantFields } } }
      ... on InventoryItem { id variants(first: 10) { nodes { ...DeploiVariantFields } } }
    }
  }
  ${VARIANT_FIELDS}
`

export const M_SET_INVENTORY_POLICY = /* GraphQL */ `
  mutation DeploiSetInventoryPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      product { id }
      productVariants { id inventoryPolicy updatedAt }
      userErrors { field message code }
    }
  }
`

export const Q_ACTIVE_SUBSCRIPTIONS = /* GraphQL */ `
  query DeploiActiveSubscriptions {
    currentAppInstallation { activeSubscriptions { id name status test trialDays currentPeriodEnd createdAt } }
  }
`

export const M_CREATE_SUBSCRIPTION = /* GraphQL */ `
  mutation DeploiCreateSubscription($name: String!, $returnUrl: URL!, $test: Boolean, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, trialDays: $trialDays, lineItems: $lineItems) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }
`

/** Variants by store-wide keys (SKU / barcode search; results are re-checked for exact matches in code). */
export const Q_FIND_VARIANTS = /* GraphQL */ `
  query DeploiFindVariants($query: String!) {
    productVariants(first: 50, query: $query) { nodes { ...DeploiVariantFields } }
  }
  ${VARIANT_FIELDS}
`

export const Q_FIND_BY_HANDLE = /* GraphQL */ `
  query DeploiFindByHandle($query: String!) {
    products(first: 10, query: $query) { nodes { variants(first: 100) { nodes { ...DeploiVariantFields } } } }
  }
  ${VARIANT_FIELDS}
`

/** Sales channels the app can publish to; the merchant picks one by name (Online Store is never guessed). */
export const Q_PUBLICATIONS = /* GraphQL */ `
  query DeploiPublications {
    shop { currencyCode }
    publications(first: 50, catalogType: APP) {
      nodes { id supportsFuturePublishing catalog { __typename id title status } }
    }
  }
`

export const M_PUBLISH = /* GraphQL */ `
  mutation DeploiPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }
`

export const M_UNPUBLISH = /* GraphQL */ `
  mutation DeploiUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
  }
`

/** One field per call (price, compare-at price or SKU), so each approved change is written and audited alone. */
export const M_UPDATE_VARIANT = /* GraphQL */ `
  mutation DeploiUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id price compareAtPrice sku updatedAt }
      userErrors { field message code }
    }
  }
`

/** Markets / B2B fixed prices that would override a base-price change for some buyers. */
export const Q_PRICE_OVERRIDES = /* GraphQL */ `
  query DeploiPriceOverrides($query: String!) {
    priceLists(first: 50) { nodes { id name currency prices(first: 1, originType: FIXED, query: $query) { nodes { price { amount currencyCode } } } } }
  }
`
