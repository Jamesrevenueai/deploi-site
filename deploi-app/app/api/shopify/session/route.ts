/**
 * Called by the embedded app on load with `Authorization: Bearer <id token>`. Completes installation
 * through token exchange when needed (expiring offline token) and starts the first scan after a new install.
 */
import { NextResponse, after } from 'next/server'
import { errorResponse, verifyShopifyBearer, bearer, HttpError } from '@/lib/store/request'
import { ensureInstalled, refreshShopFactsIfStale } from '@/lib/connectors/shopify/install'
import { runScan } from '@/lib/engine/scan'
import { admin } from '@/lib/db'
import { engineConfig } from '@/lib/engine/config'
import { syncSubscription } from '@/lib/connectors/shopify/billing'
import '@/lib/connectors'

export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const session = verifyShopifyBearer(req)
    if (!session) throw new HttpError(401, 'unauthenticated', 'session token required')
    const r = await ensureInstalled(session.shop, bearer(req)!)
    if (r.tokenExchanged) after(() => runScan(r.connectionId, { trigger: 'install', actor: `shopify:${session.shop}:install` }).then(() => undefined, () => undefined))
    else after(() => refreshShopFactsIfStale(r.connectionId, `shopify:${session.shop}:session`))
    if (engineConfig.billingRequired) after(() => admin(async db => {
      const c = await db.one<{ id: string; org_id: string; external_id: string; shop_gid: string | null; is_synthetic: boolean }>('select id, org_id, external_id, shop_gid, is_synthetic from store_connections where id = $1', [r.connectionId])
      if (c) await syncSubscription(db, c, { actor: `shopify:${session.shop}:session` })
    }).then(() => undefined, () => undefined))
    return NextResponse.json({ ok: true, connectionId: r.connectionId, created: r.created })
  } catch (e) { return errorResponse(e) }
}
