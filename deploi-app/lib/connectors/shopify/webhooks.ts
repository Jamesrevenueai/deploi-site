/**
 * Shopify webhook handling. All Shopify webhooks (app-specific subscriptions and the mandatory compliance topics) arrive here.
 * Every request must carry a valid X-Shopify-Hmac-Sha256 over the raw body (401 otherwise, as the
 * compliance requirements demand); there is no unsigned path, even in development. Deliveries are
 * de-duplicated by X-Shopify-Webhook-Id; the response is sent quickly and rescans run after it.
 * Record changes (products/*, inventory_levels/update, inventory_items/update) are debounced into one
 * targeted rescan per record (rescans.ts). app_subscriptions/update only triggers a re-read of the
 * subscription from Shopify: the payload is never trusted on its own.
 */
import { NextResponse } from 'next/server'
import { admin } from '../../db'
import { log } from '../../log'
import { invalidateProposal, type ProposalRow } from '../../engine/proposals'
import { verifyWebhookHmac, normalizeShop } from './auth'
import { shopifyConfig } from './config'
import { markUninstalled } from './install'
import { handleCompliance, type ComplianceTopic } from './compliance'
import { enqueueRescan, flushRescans, rescanConfig } from './rescans'
import { syncSubscription } from './billing'
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
    } else if (COMPLIANCE.has(topic)) {
      const r = await admin(db => handleCompliance(db, { topic: topic as ComplianceTopic, shop, webhookId, payload, conn, actor: `shopify:${shop}` }))
      await done('processed', topic === 'shop/redact'
        ? (r.result.shop_data_erased ? `shop data erased${r.result.organization_erased ? ' with its organization' : ''}` : r.result.skipped ? String(r.result.skipped) : 'no data held for this shop')
        : r.result.customer_data_held === false ? 'nothing is held for this customer' : topic === 'customers/data_request' ? 'customer data exported for the merchant to download' : `customer data erased (${JSON.stringify(r.result.tables ?? {})})`.slice(0, 500))
    } else if (topic === 'app_subscriptions/update') {
      // never trusted alone: re-read the subscription from Shopify (no-op unless billing is configured)
      if (conn) await admin(async db => {
        const c = await db.one<{ id: string; org_id: string; external_id: string; shop_gid: string | null; is_synthetic: boolean }>('select id, org_id, external_id, shop_gid, is_synthetic from store_connections where id = $1', [conn.id])
        if (c) await syncSubscription(db, c, { force: true, actor: `shopify:${shop}:webhook` }).catch(e => log.warn('shopify.billing.sync_failed', { error: (e as Error).message }))
      })
      await done('processed', 'subscription re-read from Shopify')
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
        // Debounced: the ids wait in the rescan queue and are re-read once the burst is over. The re-read also settles
        // proposals whose records changed (stale) and closes issues fixed outside Deploi. Deploi's own writes come back
        // here too; re-reading them is harmless.
        const fresh = await admin(db => enqueueRescan(db, conn.id, ids, topic))
        await done('processed', `queued a targeted rescan of ${ids.length} record(s)${fresh < ids.length ? ' (already waiting)' : ''}`)
        defer(async () => {
          if (rescanConfig.debounceMs > 0) await new Promise(r => setTimeout(r, rescanConfig.debounceMs + 250))
          try { await flushRescans({ connectionId: conn.id, actor: `shopify:${shop}:webhook:${topic}` }) }
          catch (e) { log.warn('shopify.rescan.flush_failed', { error: (e as Error).message }) }
        })
      } else await done('ignored', conn ? (conn.status === 'active' ? 'no records to re-read' : `the connection is ${conn.status}`) : 'shop not connected')
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    log.error('shopify.webhook.failed', { topic, error: (e as Error).message })
    await admin(db => db.query(`update webhook_receipts set status = 'failed', note = $2, processed_at = now() where id = $1`, [receipt.id, (e as Error).message.slice(0, 200)]))
    // every failure (compliance topics included) returns 500 so Shopify retries: a redaction must not be lost to a transient error
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
