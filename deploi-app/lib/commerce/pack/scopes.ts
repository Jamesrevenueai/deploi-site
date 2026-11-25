/**
 * Shopify access the commerce pack needs on a live store, per agent, and which of it is protected customer data.
 * None of these are added to the install scopes in this build (config.ts): the lead decides when to request them.
 * Protected customer data: any read of orders, returns or refunds is "protected customer data" (level 1) and needs
 * Shopify's approval in the Partner Dashboard; reading the shopper's name and email on an order is level 2 (the
 * name and email fields). Payouts are not customer data but need read_shopify_payments_payouts.
 */
export const COMMERCE_PACK_SCOPES: Record<string, { scopes: string[]; protectedCustomerData: 'none' | 'level1' | 'level2'; why: string }> = {
  order_tracker: { scopes: ['read_orders'], protectedCustomerData: 'level2', why: 'reads orders, fulfillments and tracking; emails the customer by first name and address' },
  returns: { scopes: ['read_orders', 'read_returns', 'write_returns', 'write_orders'], protectedCustomerData: 'level2', why: 'reads return requests, approves or declines them (write_returns), refunds (refundCreate needs write_orders)' },
  listing_writer: { scopes: ['read_products', 'write_products'], protectedCustomerData: 'none', why: 'reads product facts and metafields, writes descriptionHtml' },
  inventory_watcher: { scopes: ['read_products', 'read_inventory', 'write_products', 'read_orders'], protectedCustomerData: 'level1', why: 'reads stock and 30-day sales from orders, sets inventoryPolicy' },
  supplier_chaser: { scopes: [], protectedCustomerData: 'none', why: 'email only (the merchant\'s connected mailbox); no Shopify access' },
  customer_care: { scopes: ['read_orders'], protectedCustomerData: 'level2', why: 'matches the sender\'s email to an order and replies with its tracking' },
  campaign: { scopes: ['read_products', 'read_inventory', 'write_products'], protectedCustomerData: 'none', why: 'reads collections and stock, collectionRemoveProducts / collectionAddProducts (write_products)' },
  promo_manager: { scopes: ['read_discounts', 'write_discounts', 'read_products', 'write_products'], protectedCustomerData: 'none', why: 'reads code discounts, discountCodeDeactivate / discountCodeActivate' },
  weekly_insights: { scopes: ['read_orders', 'read_products', 'read_inventory'], protectedCustomerData: 'level1', why: 'orders and revenue for the week (no names or emails used)' },
  payout_fees_checker: { scopes: ['read_shopify_payments_payouts', 'read_orders'], protectedCustomerData: 'level1', why: 'payouts, their summary and balance transactions' },
  store_health_checker: { scopes: ['read_products', 'read_inventory', 'read_orders', 'read_discounts'], protectedCustomerData: 'level1', why: 'read-only weekly check' },
  ai_visibility: { scopes: ['read_products', 'write_products'], protectedCustomerData: 'none', why: 'reads media alt text, barcodes and SEO fields, writes seo.description' },
}

/** Every scope the pack needs, deduplicated. */
export const ALL_COMMERCE_PACK_SCOPES = [...new Set(Object.values(COMMERCE_PACK_SCOPES).flatMap(x => x.scopes))].sort()
/** Agents that need Shopify's protected customer data approval, and at which level. */
export const PROTECTED_CUSTOMER_DATA = Object.fromEntries(Object.entries(COMMERCE_PACK_SCOPES).filter(([, v]) => v.protectedCustomerData !== 'none').map(([k, v]) => [k, v.protectedCustomerData]))
