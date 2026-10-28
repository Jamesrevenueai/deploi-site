/**
 * The Admin GraphQL documents this app sends (Admin API 2026-10; see docs/platform-research/shopify.md).
 * Query cost is not documented for this selection: measure extensions.cost on a development store.
 * The Admin GraphQL documents this app sends. Operation names are stable: the synthetic store
 * dispatches on them, and they make requests easy to find in logs.
 */
export const VARIANT_FIELDS = /* GraphQL */ `
  fragment DeploiVariantFields on ProductVariant {
    id
    title
    sku
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
      updatedAt
    }
    inventoryItem {
      id
      tracked
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
