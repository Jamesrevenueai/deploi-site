/** Shopify app configuration from the environment. Nothing here has a secret default. */
const e = (k: string) => (process.env[k] ?? '').trim()

export const shopifyConfig = {
  get apiKey() { return e('SHOPIFY_API_KEY') },
  get apiSecret() { return e('SHOPIFY_API_SECRET') },
  /** Admin GraphQL API version; pin and upgrade deliberately */
  get apiVersion() { return e('SHOPIFY_API_VERSION') || '2026-10' },
  /**
   * Scopes every install gets: the reads, plus the non-protected write the ready store agents use to fix things
   * (write_products: Inventory Watcher's "stop selling when out of stock", price and SKU corrections), so a merchant
   * approves it once at install and the agents can fix at connect. No protected customer data scope.
   * Must match [access_scopes].scopes in shopify.app.toml.
   */
  get scopes() { return list(e('SHOPIFY_SCOPES') || REQUIRED_SCOPES.join(',')) },
  /**
   * Scopes asked for at runtime (App Bridge `shopify.scopes.request`) only when a merchant turns on a correction no
   * ready agent uses (sales channel publication). Must match [access_scopes].optional_scopes in shopify.app.toml.
   * Shopify refuses a runtime request for anything not declared there.
   */
  get optionalScopes() { return list(e('SHOPIFY_OPTIONAL_SCOPES') || OPTIONAL_SCOPES.join(',')) },
  get appUrl() { return e('SHOPIFY_APP_URL') || e('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000' },
  get configured() { return Boolean(this.apiKey && this.apiSecret) },
}

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean)

/**
 * Installed with the app. `write_products` is the only write the ready store agents need (lib/agents/templates.ts:
 * Inventory Watcher's oversell_policy correction; price and SKU corrections); the app never writes inventory
 * quantities (no write_inventory) and no ready agent writes discounts (write_discounts stays out). An agent the owner
 * keeps at "drafts only" or "ask first" still changes nothing without approval: the scope only lets an approved or
 * "do it and tell me" change go through without a second consent screen.
 */
export const REQUIRED_SCOPES = ['read_products', 'write_products', 'read_inventory', 'read_locations']
/** Granted later, one widening at a time: publication correction only. `read_publications` is only read when granted. */
export const OPTIONAL_SCOPES = ['read_publications', 'write_publications']
/** Write scopes requested at install (each is explained in the App Store listing, docs/app-store/LISTING.md). */
export const INSTALL_WRITE_SCOPES = REQUIRED_SCOPES.filter(s => s.startsWith('write_'))
/** Reads the scan needs. Publications are read only when `read_publications` has been granted (see queries.ts#docFor). */
export const READ_SCOPES = ['read_products', 'read_inventory', 'read_locations']
export const PUBLICATIONS_READ_SCOPE = 'read_publications'
export const ACTION_SCOPES: Record<string, string[]> = {
  'shopify.variant.set_inventory_policy': ['write_products'],
  'shopify.product.publish': ['write_publications'],
  'shopify.product.unpublish': ['write_publications'],
  'shopify.variant.set_price': ['write_products'],
  'shopify.variant.set_compare_at_price': ['write_products'],
  'shopify.variant.set_sku': ['write_products'],
}

/**
 * Webhook topics the agents react to (routed into lib/events as AgentEvents), with the access scope Shopify needs
 * for each subscription. Orders, fulfillments, customers, refunds and returns carry protected customer data:
 * Shopify delivers them only after the app's Protected customer data access request is approved in the Partner
 * Dashboard (level 1 for order data; level 2 for customer name, email, phone and address fields).
 */
export const EVENT_TOPIC_SCOPES: Record<string, { scope: string; protectedData: boolean }> = {
  'orders/create': { scope: 'read_orders', protectedData: true },
  'orders/updated': { scope: 'read_orders', protectedData: true },
  'orders/fulfilled': { scope: 'read_orders', protectedData: true },
  'orders/cancelled': { scope: 'read_orders', protectedData: true },
  'fulfillments/create': { scope: 'read_fulfillments', protectedData: true },
  'fulfillments/update': { scope: 'read_fulfillments', protectedData: true },
  'inventory_levels/update': { scope: 'read_inventory', protectedData: false },
  'products/update': { scope: 'read_products', protectedData: false },
  'customers/create': { scope: 'read_customers', protectedData: true },
  'customers/update': { scope: 'read_customers', protectedData: true },
  'refunds/create': { scope: 'read_orders', protectedData: true },
  'returns/request': { scope: 'read_returns', protectedData: true },
  'returns/approve': { scope: 'read_returns', protectedData: true },
  'returns/decline': { scope: 'read_returns', protectedData: true },
  'returns/cancel': { scope: 'read_returns', protectedData: true },
  'returns/close': { scope: 'read_returns', protectedData: true },
  'returns/reopen': { scope: 'read_returns', protectedData: true },
  'discounts/create': { scope: 'read_discounts', protectedData: false },
  'discounts/update': { scope: 'read_discounts', protectedData: false },
}
export const SHOPIFY_EVENT_TOPICS = new Set(Object.keys(EVENT_TOPIC_SCOPES))
/**
 * Topics the app subscribes to now. The first App Store submission opts out of protected customer data, so the
 * order, fulfillment, customer, refund and return topics (protectedData) are handled but not subscribed: they are
 * phase 2, after Shopify approves the protected customer data request (docs/app-store/PROTECTED-CUSTOMER-DATA.md).
 */
export const SUBSCRIBED_EVENT_TOPICS = Object.keys(EVENT_TOPIC_SCOPES).filter(t => !EVENT_TOPIC_SCOPES[t].protectedData)
export const PHASE2_EVENT_TOPICS = Object.keys(EVENT_TOPIC_SCOPES).filter(t => EVENT_TOPIC_SCOPES[t].protectedData)
/** Read scopes the subscribed agent topics add to the install (declared in shopify.app.toml [access_scopes]). */
export const EVENT_SCOPES = [...new Set(SUBSCRIBED_EVENT_TOPICS.map(t => EVENT_TOPIC_SCOPES[t].scope))].filter(s => !REQUIRED_SCOPES.includes(s)).sort()
/** Scopes phase 2 adds (all protected customer data). */
export const PHASE2_EVENT_SCOPES = [...new Set(PHASE2_EVENT_TOPICS.map(t => EVENT_TOPIC_SCOPES[t].scope))].sort()
