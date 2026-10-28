import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { runScan } from '@/lib/engine/scan'
import { withActor } from '@/lib/engine/actor'

export const maxDuration = 300

/** Read the store and re-run every enabled check. Body: { connectionId } (defaults to the only connection). */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const conns = await withActor(actor, db => db.query<{ id: string }>(`select id from store_connections where ${actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'} and status = 'active' order by created_at`))
    const id = typeof body.connectionId === 'string' ? body.connectionId : conns.length === 1 ? conns[0].id : null
    if (!id || !conns.some(c => c.id === id)) throw new HttpError(404, 'not_found', 'connection not found')
    const r = await runScan(id, { trigger: 'manual', actor: actor.label })
    return NextResponse.json({ ok: true, scan: r })
  } catch (e) { return errorResponse(e) }
}
