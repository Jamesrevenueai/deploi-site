/**
 * Webhook registration state and re-registration, per integration.
 *
 *   shopify      app subscriptions are declared in shopify.app.toml (Shopify delivers them to every shop);
 *                the shop-level list is read with `webhookSubscriptions`, and "Re-register" creates the
 *                missing topics with `webhookSubscriptionCreate` (compliance topics are app-config only)
 *   woocommerce  REST webhooks Deploi registered on connect (woo_connections.webhook_ids), checked live with
 *                GET /webhooks; "Re-register" deletes and recreates them with a new secret (webhooks.ts)
 *   quickbooks   one webhook for the Deploi app in the Intuit developer portal, for every company: nothing to
 *                register per company (no API for it)
 *   stripe       read-only: the account's webhook endpoints (GET /v1/webhook_endpoints), staff only
 * Nothing here returns a webhook secret.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { loadConnection } from '../engine/scan'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import { assertCan } from '../platform/rbac'
import { shopifyGraphql, ShopifyApiError } from '../connectors/shopify/client'
import { shopifyConfig } from '../connectors/shopify/config'
import { siteFor, wooRequest } from '../connectors/woocommerce/client'
import { deliveryUrl, registerWebhooks } from '../connectors/woocommerce/webhooks'
import { WEBHOOK_TOPICS } from '../connectors/woocommerce/config'
import { officeConfig } from '../office/config'
import { stripeRequest } from '../billing/stripe'
import type { IntegrationKey, WebhookSupport } from './types'

export type WebhookTopic = { topic: string; registered: boolean | null }
export type WebhookState = {
  support: WebhookSupport; summary: string
  topics: WebhookTopic[]; lastDeliveryAt: string | null; failedDeliveries7d: number | null
  error: string | null; canReregister: boolean
}

/** The app-specific topics shopify.app.toml subscribes to (GraphQL enum names). */
export const SHOPIFY_TOPICS = ['APP_UNINSTALLED', 'APP_SCOPES_UPDATE', 'PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'INVENTORY_LEVELS_UPDATE', 'INVENTORY_ITEMS_UPDATE'] as const
export const shopifyCallbackUrl = () => `${shopifyConfig.appUrl.replace(/\/+$/, '')}/api/shopify/webhooks`

export const Q_WEBHOOK_SUBSCRIPTIONS = /* GraphQL */ `
query DeploiWebhookSubscriptions { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`
export const M_WEBHOOK_CREATE = /* GraphQL */ `
mutation DeploiWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { webhookSubscription { id topic uri } userErrors { field message } }
}`

type SubNode = { id: string; topic: string; uri?: string | null }

async function deliveries(connectionId: string) {
  return admin(db => db.one<{ last: string | null; failed: number }>(
    `select max(received_at)::text as last, count(*) filter (where status = 'failed' and received_at > now() - interval '7 days')::int as failed from webhook_receipts where connection_id = $1`, [connectionId]))
}

async function shopifyState(connectionId: string, live: boolean): Promise<WebhookState> {
  const conn = await admin(db => loadConnection(db, connectionId))
  const d = await deliveries(connectionId)
  const base = { support: 'reregister' as const, lastDeliveryAt: d?.last ?? null, failedDeliveries7d: d?.failed ?? 0 }
  if (!conn) return { ...base, summary: 'The store connection no longer exists.', topics: [], error: null, canReregister: false }
  if (conn.is_synthetic) return { ...base, summary: 'Synthetic test store: Shopify sends it no webhooks.', topics: SHOPIFY_TOPICS.map(topic => ({ topic, registered: null })), error: null, canReregister: false }
  const declared = 'Shopify delivers the topics declared in the app configuration to every shop.'
  if (!live || conn.status !== 'active') return { ...base, summary: declared, topics: SHOPIFY_TOPICS.map(topic => ({ topic, registered: null })), error: null, canReregister: conn.status === 'active' }
  try {
    const nodes = (await shopifyGraphql<{ webhookSubscriptions: { nodes: SubNode[] } }>(conn, { query: Q_WEBHOOK_SUBSCRIPTIONS, operationName: 'DeploiWebhookSubscriptions' }, { maxAttempts: 2 })).webhookSubscriptions.nodes
    const url = shopifyCallbackUrl()
    const ours = new Set(nodes.filter(n => n.uri === url).map(n => n.topic))
    return { ...base, summary: `${declared} Shop-level subscriptions to Deploi: ${ours.size} of ${SHOPIFY_TOPICS.length}.`, topics: SHOPIFY_TOPICS.map(topic => ({ topic, registered: ours.has(topic) })), error: null, canReregister: true }
  } catch (e) {
    return { ...base, summary: declared, topics: SHOPIFY_TOPICS.map(topic => ({ topic, registered: null })), error: e instanceof ShopifyApiError ? `could not read the shop's subscriptions (${e.kind})` : 'could not read the shop\'s subscriptions', canReregister: true }
  }
}

async function wooState(connectionId: string, live: boolean): Promise<WebhookState> {
  const conn = await admin(db => loadConnection(db, connectionId))
  const meta = await admin(db => db.one<{ webhook_ids: string[]; webhooks_error: string | null }>('select webhook_ids::text[] as webhook_ids, webhooks_error from woo_connections where connection_id = $1', [connectionId]))
  const d = await deliveries(connectionId)
  const ids = (meta?.webhook_ids ?? []).map(Number)
  const base = { support: 'reregister' as const, lastDeliveryAt: d?.last ?? null, failedDeliveries7d: d?.failed ?? 0, canReregister: Boolean(conn && conn.status === 'active') }
  let topics: WebhookTopic[] = WEBHOOK_TOPICS.map(topic => ({ topic, registered: ids.length ? null : false }))
  let error = meta?.webhooks_error ?? null
  if (live && conn && conn.status === 'active') {
    try {
      const site = await siteFor(conn)
      const r = await wooRequest<{ id: number; topic: string; status: string; delivery_url: string }[]>(site, { path: '/webhooks', query: { per_page: 100 } }, { maxAttempts: 2 })
      const url = deliveryUrl(conn.id)
      const mine = (Array.isArray(r.data) ? r.data : []).filter(h => ids.includes(Number(h.id)) && h.status === 'active' && h.delivery_url === url)
      topics = WEBHOOK_TOPICS.map(topic => ({ topic, registered: mine.some(h => h.topic === topic) }))
    } catch (e) { error = `could not list the store's webhooks: ${(e as Error).message.slice(0, 120)}` }
  }
  const n = topics.filter(t => t.registered).length
  return { ...base, summary: ids.length ? (live ? `${n} of ${WEBHOOK_TOPICS.length} webhooks are registered and active on the store.` : `${ids.length} webhook${ids.length === 1 ? '' : 's'} registered when the store was connected.`) : 'No webhooks are registered: changes are picked up on the next scan.', topics, error }
}

function quickbooksState(): WebhookState {
  return {
    support: 'portal', topics: [{ topic: 'Invoice, Payment', registered: officeConfig.quickbooksWebhookVerifier ? true : null }], lastDeliveryAt: null, failedDeliveries7d: null, error: null, canReregister: false,
    summary: officeConfig.quickbooksWebhookVerifier
      ? 'QuickBooks sends invoice and payment changes to Deploi through one webhook set up for the Deploi app; there is nothing to register per company.'
      : 'QuickBooks change notifications are not set up on this deployment: invoices are re-read on each check instead.',
  }
}

async function stripeState(staff: boolean): Promise<WebhookState> {
  const base = { support: 'readonly' as const, lastDeliveryAt: null, failedDeliveries7d: null, canReregister: false }
  if (!staff) return { ...base, summary: 'Billing events are managed by Deploi.', topics: [], error: null }
  try {
    const r = await stripeRequest<{ data?: { url?: string; status?: string; enabled_events?: string[] }[] }>('GET', '/v1/webhook_endpoints', { limit: 20 }, { fetchImpl: stripeFetch })
    const mine = (r.data ?? []).filter(w => typeof w.url === 'string' && w.url.endsWith('/api/billing/stripe/webhook'))
    return { ...base, summary: mine.length ? `${mine.length} Stripe endpoint${mine.length === 1 ? '' : 's'} point at Deploi (${mine.filter(w => w.status === 'enabled').length} enabled).` : 'No Stripe webhook endpoint points at /api/billing/stripe/webhook.',
      topics: [...new Set(mine.flatMap(w => w.enabled_events ?? []))].slice(0, 20).map(topic => ({ topic, registered: true })), error: null }
  } catch (e) { return { ...base, summary: 'Could not read the Stripe webhook endpoints.', topics: [], error: (e as Error).message.slice(0, 160) } }
}

let stripeFetch: typeof fetch | undefined
/** Tests only: route the Stripe webhook read through a fake fetch. */
export function setWebhookStripeFetch(f: typeof fetch | null) { stripeFetch = f ?? undefined }

export async function webhookState(key: IntegrationKey, connectionId: string | null, opts: { live?: boolean; staff?: boolean } = {}): Promise<WebhookState | null> {
  if (key === 'shopify' && connectionId) return shopifyState(connectionId, opts.live ?? true)
  if (key === 'woocommerce' && connectionId) return wooState(connectionId, opts.live ?? true)
  if (key === 'quickbooks') return quickbooksState()
  if (key === 'stripe') return stripeState(Boolean(opts.staff))
  return null
}

/**
 * Re-register webhooks for one store connection of the actor's organization. Shopify: create the missing
 * topics at the shop level (webhookSubscriptionCreate); WooCommerce: recreate Deploi's webhooks.
 */
export async function reregisterWebhooks(actor: Actor, key: IntegrationKey, connectionId: string): Promise<{ created: number; existing: number; errors: string[]; message: string }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view webhooks but not change them for a customer')
  await assertCan(actor, actor.orgId, 'connect')
  if (key !== 'shopify' && key !== 'woocommerce') throw new EngineError('invalid_input', 'this integration has no webhooks to re-register here')
  const conn = await admin(db => loadConnection(db, connectionId))
  if (!conn || conn.org_id !== actor.orgId || conn.platform !== key) throw new EngineError('not_found', 'connection not found')
  if (conn.status !== 'active') throw new EngineError('invalid_input', 'reconnect the store first')
  if (conn.is_synthetic) return { created: 0, existing: 0, errors: [], message: 'Synthetic test store: there are no webhooks to register.' }
  if (key === 'woocommerce') {
    const r = await registerWebhooks(conn, await siteFor(conn), actor.label)
    return { created: r.ids.length, existing: 0, errors: r.error ? [r.error] : [], message: r.error ? `Registered ${r.ids.length} of ${WEBHOOK_TOPICS.length}: ${r.error}` : `Registered ${r.ids.length} webhooks on the store.` }
  }
  const url = shopifyCallbackUrl()
  if (!url.startsWith('https://')) throw new EngineError('invalid_input', 'webhooks need Deploi to be reachable over https')
  const nodes = (await shopifyGraphql<{ webhookSubscriptions: { nodes: SubNode[] } }>(conn, { query: Q_WEBHOOK_SUBSCRIPTIONS, operationName: 'DeploiWebhookSubscriptions' })).webhookSubscriptions.nodes
  const have = new Set(nodes.filter(n => n.uri === url).map(n => n.topic))
  let created = 0
  const errors: string[] = []
  for (const topic of SHOPIFY_TOPICS.filter(t => !have.has(t))) {
    try {
      const r = await shopifyGraphql<{ webhookSubscriptionCreate: { webhookSubscription: SubNode | null; userErrors: { field?: string[]; message: string }[] } }>(conn,
        { query: M_WEBHOOK_CREATE, operationName: 'DeploiWebhookSubscriptionCreate', variables: { topic, webhookSubscription: { uri: url, format: 'JSON' } } }, { mutation: true })
      if (r.webhookSubscriptionCreate.userErrors.length) errors.push(`${topic}: ${r.webhookSubscriptionCreate.userErrors.map(u => u.message).join('; ').slice(0, 160)}`)
      else if (r.webhookSubscriptionCreate.webhookSubscription) created++
    } catch (e) { errors.push(`${topic}: ${(e as Error).message.slice(0, 160)}`) }
  }
  await admin(db => audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.webhooks_registered', actor: actor.label, detail: { platform: 'shopify', created, existing: have.size, errors: errors.length } }))
  return { created, existing: have.size, errors, message: errors.length ? `Created ${created}; ${errors.length} failed.` : created ? `Created ${created} missing subscription${created === 1 ? '' : 's'}.` : 'Every topic is already subscribed.' }
}
