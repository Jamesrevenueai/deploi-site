/**
 * WooCommerce webhooks. On connect Deploi registers product.updated, product.deleted and order.created
 * through REST, each with a per-connection secret (stored encrypted) and a delivery URL that names the
 * connection. Deliveries must carry X-WC-Webhook-Signature = base64(HMAC-SHA256(raw body, secret)),
 * compared in constant time; the unsigned ping WooCommerce sends when a webhook is created is
 * acknowledged and ignored. Deliveries are de-duplicated by X-WC-Webhook-Delivery-ID (webhook_receipts)
 * and trigger a targeted rescan of the changed products after the response.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { admin } from '../../db'
import { env } from '../../env'
import { log } from '../../log'
import { audit } from '../../engine/audit'
import { runScan, loadConnection } from '../../engine/scan'
import { invalidateProposal, type ProposalRow } from '../../engine/proposals'
import { encryptSecret, decryptSecret } from '../credentials'
import type { ConnectionRow } from '../../engine/types'
import { wooRequest, type WooSite } from './client'
import { WEBHOOK_TOPICS } from './config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function webhookSignature(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw, 'utf8').digest('base64')
}

/** Constant-time comparison of the delivered signature with the expected one. */
export function verifyWooSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const expected = Buffer.from(webhookSignature(raw, secret))
  const got = Buffer.from(header.trim())
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export const deliveryUrl = (connectionId: string) => `${env.appUrl.replace(/\/+$/, '')}/api/woocommerce/webhooks?c=${connectionId}`

/** Register (or re-register) this app's webhooks. Best effort: a failure is recorded and shown, never fatal to the connection. */
export async function registerWebhooks(conn: ConnectionRow, site: WooSite, actor: string): Promise<{ ids: number[]; error: string | null }> {
  const url = deliveryUrl(conn.id)
  if (!url.startsWith('https://')) {
    const error = 'webhooks need Deploi to be reachable over https; changes are picked up on the next scan instead'
    await admin(db => db.query('update woo_connections set webhooks_error = $2 where connection_id = $1', [conn.id, error]))
    return { ids: [], error }
  }
  await deleteWebhooks(conn, site, actor)
  const secret = randomBytes(32).toString('base64url')
  const ids: number[] = []
  let error: string | null = null
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const r = await wooRequest<{ id: number }>(site, { method: 'POST', path: '/webhooks', body: { name: `Deploi: ${topic}`, topic, delivery_url: url, secret, status: 'active' } })
      if (typeof r.data.id === 'number') ids.push(r.data.id)
    } catch (e) { error = `could not register ${topic}: ${(e as Error).message.slice(0, 160)}` }
  }
  const enc = encryptSecret(secret, `${conn.id}:woo-webhook`)
  await admin(async db => {
    await db.query('update woo_connections set webhook_ids = $2, webhook_key_id = $3, webhook_secret_ciphertext = $4, webhooks_error = $5 where connection_id = $1', [conn.id, ids, enc.keyId, enc.ciphertext, error])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.webhooks_registered', actor, detail: { topics: WEBHOOK_TOPICS, registered: ids.length, error } })
  })
  return { ids, error }
}

/** Delete the webhooks this app registered (best effort; a webhook already gone is fine). */
export async function deleteWebhooks(conn: ConnectionRow, site: WooSite, actor: string): Promise<number> {
  const row = await admin(db => db.one<{ webhook_ids: string[] }>('select webhook_ids from woo_connections where connection_id = $1', [conn.id]))
  let deleted = 0
  for (const id of (row?.webhook_ids ?? []).map(Number)) {
    try { await wooRequest(site, { method: 'DELETE', path: `/webhooks/${id}`, query: { force: true } }); deleted++ } catch (e) {
      if ((e as { kind?: string }).kind === 'not_found') deleted++
    }
  }
  if (row?.webhook_ids?.length) await admin(async db => {
    await db.query(`update woo_connections set webhook_ids = '{}' where connection_id = $1`, [conn.id])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.webhooks_deleted', actor, detail: { deleted, registered: row.webhook_ids.length } })
  })
  return deleted
}

/** Records to re-read for a delivery. Variations arrive as product.updated with their parent id. */
export function wooTargetIds(topic: string, payload: Record<string, unknown>): string[] {
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null)
  if (topic === 'product.updated' || topic === 'product.created' || topic === 'product.restored') {
    const id = n(payload.parent_id) ?? n(payload.id)
    return id ? [`product:${id}`] : []
  }
  if (topic === 'order.created' || topic === 'order.updated') {
    const items = Array.isArray(payload.line_items) ? payload.line_items as Record<string, unknown>[] : []
    return [...new Set(items.map(i => n(i.product_id)).filter((x): x is number => x !== null).map(id => `product:${id}`))].slice(0, 100)
  }
  return []
}

/** Handle one delivery. `defer` runs work after the response (next/server `after` in the route; inline in tests). */
export async function handleWooWebhook(req: Request, defer: (fn: () => Promise<void>) => void): Promise<NextResponse> {
  const raw = await req.text()
  const signature = req.headers.get('x-wc-webhook-signature')
  // the creation ping is form-encoded "webhook_id=<id>" and unsigned: acknowledge it, act on nothing
  if (!signature && /^webhook_id=\d+$/.test(raw.trim())) return NextResponse.json({ ok: true, ping: true })
  const c = new URL(req.url).searchParams.get('c') ?? ''
  if (!UUID.test(c)) return NextResponse.json({ ok: false, error: 'unknown connection' }, { status: 404 })
  const meta = await admin(db => db.one<{ webhook_key_id: string | null; webhook_secret_ciphertext: string | null }>(
    `select w.webhook_key_id, w.webhook_secret_ciphertext from woo_connections w join store_connections s on s.id = w.connection_id where w.connection_id = $1 and s.platform = 'woocommerce'`, [c]))
  let secret = ''
  try { if (meta?.webhook_key_id && meta.webhook_secret_ciphertext) secret = decryptSecret(meta.webhook_key_id, meta.webhook_secret_ciphertext, `${c}:woo-webhook`) } catch { secret = '' }
  if (!verifyWooSignature(raw, signature, secret)) {
    log.warn('woocommerce.webhook.bad_signature', { connection_id: c, topic: req.headers.get('x-wc-webhook-topic') })
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 })
  }
  const topic = (req.headers.get('x-wc-webhook-topic') ?? '').toLowerCase()
  const deliveryId = (req.headers.get('x-wc-webhook-delivery-id') ?? '').trim()
  if (!topic || !deliveryId || deliveryId.length > 200) return NextResponse.json({ ok: false, error: 'missing headers' }, { status: 400 })
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }

  const conn = await admin(db => loadConnection(db, c))
  const receipt = await admin(db => db.one<{ id: string }>(
    `insert into webhook_receipts (platform, delivery_id, topic, connection_id) values ('woocommerce',$1,$2,$3)
     on conflict (platform, delivery_id) do update set status = 'accepted', note = 'retry after failure', processed_at = null
     where webhook_receipts.status = 'failed' returning id`, [`${c}:${deliveryId}`, topic.slice(0, 80), c]))
  if (!receipt) return NextResponse.json({ ok: true, duplicate: true })
  const done = (status: 'processed' | 'ignored', note: string) => admin(db => db.query(`update webhook_receipts set status = $2, note = $3, processed_at = now() where id = $1`, [receipt.id, status, note]))
  try {
    if (!conn || conn.status !== 'active') { await done('ignored', 'store not connected'); return NextResponse.json({ ok: true }) }
    if (topic === 'product.deleted') {
      // WordPress post ids are unique across products and variations, so one id names either
      const id = Number(payload.id)
      if (Number.isInteger(id) && id > 0) await admin(async db => {
        const issues = await db.query<{ id: string }>(`update issues set status = 'resolved', resolved_at = now(), resolution = 'no_longer_detected', status_reason = 'product deleted in WooCommerce'
          where connection_id = $1 and status in ('open','needs_review') and (evidence ->> 'productId' = $2 or evidence ->> 'variationId' = $2) returning id`, [conn.id, String(id)])
        const props = await db.query<ProposalRow>(`select * from proposals where issue_id = any($1::uuid[]) and status in ('pending_approval','approved')`, [issues.map(i => i.id)])
        for (const p of props) await invalidateProposal(db, p, 'stale', 'product deleted in WooCommerce', `woocommerce:${conn.id}:webhook`)
      })
      await done('processed', 'issues for the deleted product closed')
      return NextResponse.json({ ok: true })
    }
    const ids = wooTargetIds(topic, payload)
    if (!ids.length) { await done('ignored', 'no records to re-read'); return NextResponse.json({ ok: true }) }
    defer(async () => {
      try { await runScan(conn.id, { trigger: 'webhook', resourceIds: ids, actor: `woocommerce:${conn.id}:webhook:${topic}` }); await done('processed', `targeted rescan of ${ids.length} product(s)`) }
      catch (e) { await admin(db => db.query(`update webhook_receipts set status = 'failed', note = $2, processed_at = now() where id = $1`, [receipt.id, (e as Error).message.slice(0, 200)])) }
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    log.error('woocommerce.webhook.failed', { topic, error: (e as Error).message })
    await admin(db => db.query(`update webhook_receipts set status = 'failed', note = $2, processed_at = now() where id = $1`, [receipt.id, (e as Error).message.slice(0, 200)]))
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
