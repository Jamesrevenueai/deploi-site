/** Shopify app configuration from the environment. Nothing here has a secret default. */
const e = (k: string) => (process.env[k] ?? '').trim()

export const shopifyConfig = {
  get apiKey() { return e('SHOPIFY_API_KEY') },
  get apiSecret() { return e('SHOPIFY_API_SECRET') },
  /** Admin GraphQL API version; pin and upgrade deliberately */
  get apiVersion() { return e('SHOPIFY_API_VERSION') || '2026-10' },
  /** least privilege for the operational workflow */
  get scopes() { return (e('SHOPIFY_SCOPES') || 'read_products,write_products,read_inventory,read_locations').split(',').map(s => s.trim()).filter(Boolean) },
  get appUrl() { return e('SHOPIFY_APP_URL') || e('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000' },
  get configured() { return Boolean(this.apiKey && this.apiSecret) },
}

export const READ_SCOPES = ['read_products', 'read_inventory', 'read_locations']
export const ACTION_SCOPES: Record<string, string[]> = {
  'shopify.variant.set_inventory_policy': ['write_products'],
}
