/**
 * Called by the embedded app on load with `Authorization: Bearer <id token>`. Completes installation
 * through token exchange when needed (expiring offline token) and starts the first scan after a new install.
 */
import { NextResponse, after } from 'next/server'
import { errorResponse, verifyShopifyBearer, bearer, HttpError } from '@/lib/store/request'
import { ensureInstalled } from '@/lib/connectors/shopify/install'
import { runScan } from '@/lib/engine/scan'
import '@/lib/connectors'

export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const session = verifyShopifyBearer(req)
    if (!session) throw new HttpError(401, 'unauthenticated', 'session token required')
    const r = await ensureInstalled(session.shop, bearer(req)!)
    if (r.tokenExchanged) after(() => runScan(r.connectionId, { trigger: 'install', actor: `shopify:${session.shop}:install` }).then(() => undefined, () => undefined))
    return NextResponse.json({ ok: true, connectionId: r.connectionId, created: r.created })
  } catch (e) { return errorResponse(e) }
}
