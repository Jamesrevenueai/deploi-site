import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { withActor, assertMerchant } from '@/lib/engine/actor'
import { loadConnection } from '@/lib/engine/scan'
import { getAccess, redeemInvite, requestAccess } from '@/lib/engine/access'

export const dynamic = 'force-dynamic'

/** Only a store the caller can see (RLS), loaded with the service role afterwards. */
async function visibleConnection(req: Request, id: string, mutating: boolean) {
  const actor = await resolveActor(req, { mutating })
  const visible = await withActor(actor, db => db.one<{ id: string }>('select id from store_connections where id = $1', [id]))
  if (!visible) throw new HttpError(404, 'not_found', 'store not found')
  const conn = await admin(db => loadConnection(db, id))
  if (!conn) throw new HttpError(404, 'not_found', 'store not found')
  return { actor, conn }
}

/** This store's access (beta eligibility). ?connection=<id> */
export async function GET(req: Request) {
  try {
    const { conn } = await visibleConnection(req, new URL(req.url).searchParams.get('connection') ?? '', false)
    return NextResponse.json({ ok: true, access: await admin(db => getAccess(db, conn)) })
  } catch (e) { return errorResponse(e) }
}

/** { connection, action: "redeem", code } or { connection, action: "request", note } */
export async function POST(req: Request) {
  try {
    const body = await readJson(req)
    const { actor, conn } = await visibleConnection(req, String(body.connection ?? ''), true)
    assertMerchant(actor, conn.org_id)
    if (body.action === 'redeem') {
      const code = typeof body.code === 'string' ? body.code : ''
      const r = await admin(db => redeemInvite(db, conn, code, actor.label))
      if (!r.ok) throw new HttpError(400, 'invalid_input', r.error)
      return NextResponse.json({ ok: true, access: r.access })
    }
    if (body.action === 'request') {
      const note = typeof body.note === 'string' ? body.note : ''
      return NextResponse.json({ ok: true, access: await admin(db => requestAccess(db, conn, note, actor.label)) })
    }
    throw new HttpError(400, 'invalid_input', 'action must be "redeem" or "request"')
  } catch (e) { return errorResponse(e) }
}
