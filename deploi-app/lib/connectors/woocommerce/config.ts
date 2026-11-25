/**
 * WooCommerce connector constants. The connector talks only to the merchant's own store through the
 * REST API v3 (`/wp-json/wc/v3`), with a consumer key pair the merchant approved in wp-admin
 * (scope read_write: a write-only key cannot read, and every write is preceded and followed by reads).
 * Evidence for each value: docs/platform-research/woocommerce.md.
 */
export const WC_API_BASE = '/wp-json/wc/v3'
export const WC_API_VERSION = 'wc/v3'
/** WordPress REST caps per_page at 100 (and so does the WooCommerce CRUD controller schema). */
export const WC_PER_PAGE = 100
/** v3 needs WooCommerce 3.5+. Older stores are refused at connect. */
export const WC_MIN_VERSION = '3.5.0'
/** Name shown to the merchant on the WooCommerce approval screen and on the generated key's description. */
export const WC_APP_NAME = 'Deploi'
/** The one sales "channel" a WooCommerce store has: its own storefront (status publish vs draft). */
export const WOO_STOREFRONT = 'woocommerce:storefront'

/** Key permission -> the scopes recorded on the connection (and required by each action). */
export const READ_SCOPES = ['read']
export const WRITE_SCOPE = 'write'
export function scopesForPermission(p: string): string[] {
  return p === 'read_write' ? ['read', 'write'] : p === 'read' ? ['read'] : p === 'write' ? ['write'] : []
}

export const wooConfig = {
  /** an authorization started from Deploi must come back within this time */
  stateTtlMs: 30 * 60e3,
  requestTimeoutMs: 20_000,
  maxResponseBytes: 8 * 1024 * 1024,
  /** bounded retries for reads only; writes are never retried automatically */
  readAttempts: 4,
  baseDelayMs: 250,
  maxRetryAfterMs: 5_000,
}

/** Webhook topics registered on connect. product.updated also fires for variation saves and order-driven stock changes. */
export const WEBHOOK_TOPICS = ['product.updated', 'product.deleted', 'order.created'] as const
