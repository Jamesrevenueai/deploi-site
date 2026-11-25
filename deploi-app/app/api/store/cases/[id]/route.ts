import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError, readJson } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { getCase } from '@/lib/cases'
import { closeCase, closeHandler } from '@/lib/cases/close'
// every case kind registers its checker and whether the owner may close it
import '@/lib/cases/jobs'

export const dynamic = 'force-dynamic'

/** One case (by id or DC- reference) with its full history, and whether you can close it here. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const { id } = await params
    const r = await withActor(actor, db => getCase(db, actor.orgId, id))
    if (!r) throw new HttpError(404, 'not_found', 'case not found')
    const h = closeHandler(r.case.kind)
    const open = !['resolved', 'cancelled'].includes(r.case.status)
    return NextResponse.json({ ok: true, ...r, close: h && open ? { label: h.label, needsReason: h.needsReason } : null })
  } catch (e) { return errorResponse(e) }
}

/**
 * Close a case yourself: { reason } (acknowledging a market signal needs none). Only kinds that allow it
 * (restock requests, market signals, agent library work); the case is cancelled with the reason, never resolved.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await params
    const body = await readJson(req)
    const c = await closeCase(actor, id, { reason: typeof body.reason === 'string' ? body.reason : null })
    return NextResponse.json({ ok: true, case: c })
  } catch (e) { return errorResponse(e) }
}
