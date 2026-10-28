import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { loadConnection } from '@/lib/engine/scan'
import { listPublications } from '@/lib/connectors/shopify/connector'

export const dynamic = 'force-dynamic'

/** Sales channels the app can publish to on this store, and the store currency. ?connection=<id> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const id = new URL(req.url).searchParams.get('connection') ?? ''
    const visible = await withActor(actor, db => db.one<{ id: string }>('select id from store_connections where id = $1', [id]))
    if (!visible) throw new HttpError(404, 'not_found', 'store not found')
    const conn = await admin(db => loadConnection(db, id))
    if (!conn || conn.platform !== 'shopify' || conn.status !== 'active') throw new HttpError(409, 'connection_inactive', 'the store is not connected')
    const r = await listPublications(conn)
    if (r.currency && r.currency !== conn.currency) await admin(db => db.query('update store_connections set currency = $2 where id = $1', [id, r.currency]))
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
