/** Shopify app configuration from the environment. Nothing here has a secret default. */
const e = (k: string) => (process.env[k] ?? '').trim()

export const shopifyConfig = {
  get apiKey() { return e('SHOPIFY_API_KEY') },
  get apiSecret() { return e('SHOPIFY_API_SECRET') },
  /** Admin GraphQL API version; pin and upgrade deliberately */
  get apiVersion() { return e('SHOPIFY_API_VERSION') || '2026-10' },
  /**
   * Scopes every install gets: read only. They are enough for the three starter templates at "drafts only".
   * Must match [access_scopes].scopes in shopify.app.toml.
   */
  get scopes() { return list(e('SHOPIFY_SCOPES') || REQUIRED_SCOPES.join(',')) },
  /**
   * Scopes asked for at runtime (App Bridge `shopify.scopes.request`) only when a merchant widens an agent past
   * drafts only. Must match [access_scopes].optional_scopes in shopify.app.toml. Shopify refuses a runtime
   * request for anything not declared there.
   */
  get optionalScopes() { return list(e('SHOPIFY_OPTIONAL_SCOPES') || OPTIONAL_SCOPES.join(',')) },
  get appUrl() { return e('SHOPIFY_APP_URL') || e('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000' },
  get configured() { return Boolean(this.apiKey && this.apiSecret) },
}

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean)

/** Installed with the app. */
export const REQUIRED_SCOPES = ['read_products', 'read_inventory', 'read_locations']
/** Granted later, one widening at a time. `write_products` implies `read_products`; `read_publications` is only read when granted. */
export const OPTIONAL_SCOPES = ['write_products', 'read_publications', 'write_publications']
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
