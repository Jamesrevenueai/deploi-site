/**
 * Shopify webhook handling. All Shopify webhooks (app-specific subscriptions and the mandatory compliance topics) arrive here.
 * Every request must carry a valid X-Shopify-Hmac-Sha256 over the raw body (401 otherwise, as the
 * compliance requirements demand); there is no unsigned path, even in development. Deliveries are
 * de-duplicated by X-Shopify-Webhook-Id; the response is sent quickly and rescans run after it.
 */
import { NextResponse } from 'next/server'
import { admin } from '../../db'
import { log } from '../../log'
import { audit } from '../../engine/audit'
import { runScan } from '../../engine/scan'
import { invalidateProposal, type ProposalRow } from '../../engine/proposals'
import { verifyWebhookHmac, normalizeShop } from './auth'
import { shopifyConfig } from './config'
import { markUninstalled, redactShop } from './install'
import '../index'

const COMPLIANCE = new Set(['customers/data_request', 'customers/redact', 'shop/redact'])

function targetIds(topic: string, payload: Record<string, unknown>): string[] {
  if (topic.startsWith('products/') && typeof payload.admin_graphql_api_id === 'string') return [payload.admin_graphql_api_id]
  if (topic === 'inventory_items/update' && typeof payload.admin_graphql_api_id === 'string') return [payload.admin_graphql_api_id]
  if (topic === 'inventory_levels/update' && (typeof payload.inventory_item_id === 'number' || typeof payload.inventory_item_id === 'string')) return [`gid://shopify/InventoryItem/${payload.inventory_item_id}`]
  return []
}

/** Handle one webhook request. `defer` runs work after the response (next/server `after` in the route; inline in tests). */
export async function handleShopifyWebhook(req: Request, defer: (fn: () => Promise<void>) => void): Promise<NextResponse> {
  const secret = shopifyConfig.apiSecret
  if (!secret) { log.error('shopify.webhook.secret_missing', {}); return NextResponse.json({ ok: false, error: 'webhook secret not configured' }, { status: 503 }) }
  const raw = await req.text()
  if (!verifyWebhookHmac(raw, req.headers.get('x-shopify-hmac-sha256'), secret)) {
    log.warn('shopify.webhook.bad_hmac', { topic: req.headers.get('x-shopify-topic') })
    return NextResponse.json({ ok: false, error: 'invalid hmac' }, { status: 401 })
  }
  const topic = (req.headers.get('x-shopify-topic') ?? '').toLowerCase()
  const shop = normalizeShop(req.headers.get('x-shopify-shop-domain'))
  const webhookId = req.headers.get('x-shopify-webhook-id')
  if (!topic || !shop || !webhookId) return NextResponse.json({ ok: false, error: 'missing headers' }, { status: 400 })
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }

  const conn = await admin(db => db.one<{ id: string; org_id: string; status: string }>(`select id, org_id, status from store_connections where platform = 'shopify' and external_id = $1`, [shop]))
  const receipt = await admin(db => db.one<{ id: string }>(
    `insert into webhook_receipts (platform, delivery_id, topic, connection_id) values ('shopify',$1,$2,$3)
     on conflict (platform, delivery_id) do update set status = 'accepted', note = 'retry after failure', processed_at = null
     where webhook_receipts.status = 'failed' returning id`, [webhookId, topic, conn?.id ?? null]))
  // a delivery already processed (or in progress) is acknowledged once; one that failed is processed again on Shopify's retry
  if (!receipt) return NextResponse.json({ ok: true, duplicate: true })

  const done = (status: 'processed' | 'ignored', note: string) => admin(db => db.query(`update webhook_receipts set status = $2, note = $3, processed_at = now() where id = $1`, [receipt.id, status, note]))
  try {
    if (topic === 'app/uninstalled') {
      await admin(db => markUninstalled(db, shop, `shopify:${shop}:webhook`))
      await done('processed', 'connection marked uninstalled; credentials deleted')
    } else if (topic === 'customers/data_request' || topic === 'customers/redact') {
      // The app requests no customer or order scopes and stores no customer data, so there is nothing to export or erase.
      if (conn) await admin(db => audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'webhook', entityId: receipt.id, event: `compliance.${topic.replace('/', '.')}`, actor: `shopify:${shop}`, detail: { customer_data_held: false } }))
      await done('processed', 'no customer data is stored by this app')
    } else if (topic === 'shop/redact') {
      const r = await admin(db => redactShop(db, shop))
      await done('processed', r.deleted ? `shop data erased${r.orgDeleted ? ' with its organization' : ''}` : 'no data held for this shop')
    } else if (topic === 'app/scopes_update') {
      const current = Array.isArray(payload.current) ? payload.current.map(String) : null
      if (conn && current) await admin(db => db.query('update store_connections set scopes = $2 where id = $1', [conn.id, current]))
      await done('processed', 'scopes updated')
    } else if (topic === 'products/delete') {
      const productId = typeof payload.id === 'number' || typeof payload.id === 'string' ? `gid://shopify/Product/${payload.id}` : null
      if (conn && productId) await admin(async db => {
        const issues = await db.query<{ id: string }>(`update issues set status = 'resolved', resolved_at = now(), resolution = 'no_longer_detected', status_reason = 'product deleted in Shopify'
          where connection_id = $1 and status in ('open','needs_review') and evidence ->> 'productId' = $2 returning id`, [conn.id, productId])
        const props = await db.query<ProposalRow>(`select * from proposals where issue_id = any($1::uuid[]) and status in ('pending_approval','approved')`, [issues.map(i => i.id)])
        for (const p of props) await invalidateProposal(db, p, 'stale', 'product deleted in Shopify', `shopify:${shop}:webhook`)
      })
      await done('processed', 'issues for the deleted product closed')
    } else {
      const ids = targetIds(topic, payload)
      if (conn?.status === 'active' && ids.length) {
        // Re-read the changed records after responding. This also settles proposals whose records changed (stale)
        // and closes issues fixed outside Deploi. Deploi's own writes come back here too; re-reading them is harmless.
        defer(async () => {
          try { await runScan(conn.id, { trigger: 'webhook', resourceIds: ids, actor: `shopify:${shop}:webhook:${topic}` }); await done('processed', `targeted rescan of ${ids.length} record(s)`) }
          catch (e) { await admin(db => db.query(`update webhook_receipts set status = 'failed', note = $2, processed_at = now() where id = $1`, [receipt.id, (e as Error).message.slice(0, 200)])) }
        })
      } else await done('ignored', conn ? 'no records to re-read' : 'shop not connected')
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    log.error('shopify.webhook.failed', { topic, error: (e as Error).message })
    await admin(db => db.query(`update webhook_receipts set status = 'failed', note = $2, processed_at = now() where id = $1`, [receipt.id, (e as Error).message.slice(0, 200)]))
    // compliance topics must be acknowledged; other failures return 500 so Shopify retries
    return NextResponse.json({ ok: false }, { status: COMPLIANCE.has(topic) ? 200 : 500 })
  }
}
