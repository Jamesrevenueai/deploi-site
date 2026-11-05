import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { getCase } from '@/lib/cases'

export const dynamic = 'force-dynamic'

/** One case (by id or DC- reference) with its full history. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const { id } = await params
    const r = await withActor(actor, db => getCase(db, actor.orgId, id))
    if (!r) throw new HttpError(404, 'not_found', 'case not found')
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
