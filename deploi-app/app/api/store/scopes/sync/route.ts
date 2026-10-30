import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { withActor, assertMerchant } from '@/lib/engine/actor'
import { loadConnection } from '@/lib/engine/scan'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { syncScopes, requestableScopes } from '@/lib/connectors/shopify/scopes'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

/**
 * Re-read the scopes Shopify has granted this store (called after the embedded app asks the merchant for an
 * optional scope). Body { connectionId }. The browser's view of the grant is never trusted: the list comes from Shopify.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const id = String(body.connectionId ?? '')
    const visible = await withActor(actor, db => db.one<{ id: string; org_id: string; platform: string }>('select id, org_id, platform from store_connections where id = $1', [id]))
    if (!visible) throw new HttpError(404, 'not_found', 'store not found')
    assertMerchant(actor, visible.org_id)
    if (visible.platform !== 'shopify') throw new HttpError(400, 'invalid_input', 'only Shopify stores have runtime scopes')
    const r = await admin(async db => { const conn = await loadConnection(db, id); if (!conn) throw new HttpError(404, 'not_found', 'store not found'); return syncScopes(db, conn, actor.label) })
    return NextResponse.json({ ok: true, granted: r.granted, changed: r.changed, requestable: requestableScopes() })
  } catch (e) { return errorResponse(e) }
}
