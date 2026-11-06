import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { addCrewMember, listCrew, setCrewActive, updateCrewMember } from '@/lib/notify/crew'

export const dynamic = 'force-dynamic'

/** The crew (packers, warehouse, field crew) and whether you may manage it. Every member of the organization may look. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await listCrew(actor)) })
  } catch (e) { return errorResponse(e) }
}

/**
 * { action: 'add', name, role, email, phone, channels } | { action: 'update', id, ...fields }
 * | { action: 'deactivate', id } | { action: 'reactivate', id }. Owners and admins only (checked on the server).
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const id = typeof body.id === 'string' ? body.id : ''
    switch (body.action) {
      case 'add': return NextResponse.json({ ok: true, member: await addCrewMember(actor, body) })
      case 'update': return NextResponse.json({ ok: true, member: await updateCrewMember(actor, id, body) })
      case 'deactivate': return NextResponse.json({ ok: true, member: await setCrewActive(actor, id, false) })
      case 'reactivate': return NextResponse.json({ ok: true, member: await setCrewActive(actor, id, true) })
      default: throw new HttpError(400, 'invalid_input', 'action must be add, update, deactivate or reactivate')
    }
  } catch (e) { return errorResponse(e) }
}
