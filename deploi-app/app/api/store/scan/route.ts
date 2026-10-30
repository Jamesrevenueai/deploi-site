import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { runScan } from '@/lib/engine/scan'
import { assertMerchant, withActor } from '@/lib/engine/actor'

export const maxDuration = 300

/** Read the store and re-run every enabled check. Body: { connectionId } (defaults to the only connection). */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const conns = await withActor(actor, db => db.query<{ id: string; org_id: string }>(`select id, org_id from store_connections where ${actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'} and status = 'active' order by created_at`))
    const id = typeof body.connectionId === 'string' ? body.connectionId : conns.length === 1 ? conns[0].id : null
    const conn = id ? conns.find(c => c.id === id) : undefined
    if (!conn) throw new HttpError(404, 'not_found', 'connection not found')
    // staff can read a store for support but never start work on it
    assertMerchant(actor, conn.org_id)
    const r = await runScan(conn.id, { trigger: 'manual', actor: actor.label })
    return NextResponse.json({ ok: true, scan: r })
  } catch (e) { return errorResponse(e) }
}
