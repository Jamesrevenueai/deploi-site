import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { engineConfig } from '@/lib/engine/config'
import { billingConfig, pricingPlansUrl, syncSubscription } from '@/lib/connectors/shopify/billing'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/**
 * The store's plan. ?connection=<id>[&refresh=1]. `refresh` re-reads the Partner API (used after
 * Shopify's plan page redirects back with plan_handle). When billing is not required, nothing is checked.
 */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams
    const id = q.get('connection') ?? ''
    const visible = await withActor(actor, db => db.one<{ id: string }>('select id from store_connections where id = $1', [id]))
    if (!visible) throw new HttpError(404, 'not_found', 'store not found')
    const conn = await admin(db => db.one<{ id: string; org_id: string; platform: string; external_id: string; shop_gid: string | null; is_synthetic: boolean }>(
      'select id, org_id, platform, external_id, shop_gid, is_synthetic from store_connections where id = $1', [id]))
    if (!conn || conn.platform !== 'shopify') throw new HttpError(404, 'not_found', 'store not found')
    const required = engineConfig.billingRequired
    let active = false, planHandle: string | null = null, checkFailed = false
    if (required) {
      try {
        const r = await admin(db => syncSubscription(db, conn, { force: q.get('refresh') === '1', actor: actor.label }))
        active = r.active; planHandle = r.planHandle
      } catch (e) {
        checkFailed = true
        log.warn('billing.sync_failed', { error: (e as Error).message.slice(0, 160) })
        const row = await admin(db => db.one<{ plan_key: string }>(`select plan_key from app_subscriptions where connection_id = $1 and status = 'active' limit 1`, [conn.id]))
        active = Boolean(row); planHandle = row?.plan_key ?? null
      }
    }
    return NextResponse.json({
      ok: true,
      billing: { required, active: required ? active : true, planHandle, checkFailed, plansUrl: conn.is_synthetic ? null : pricingPlansUrl(conn.external_id), partnerApiConfigured: billingConfig.partnerApiConfigured },
    })
  } catch (e) { return errorResponse(e) }
}
