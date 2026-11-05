import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { decideResolution } from '@/lib/commerce/supplier-coordinator'

export const dynamic = 'force-dynamic'

/** Approve or reject one resolution option. Body { decision: 'approve'|'reject', version: <the change hash you were shown> }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await params
    const body = await readJson(req)
    if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(400, 'invalid_input', 'decision must be approve or reject')
    if (typeof body.version !== 'string' || !body.version) throw new HttpError(400, 'invalid_input', 'the version you were shown is required')
    return NextResponse.json({ ok: true, ...(await decideResolution(actor, id, body.version, body.decision)) })
  } catch (e) { return errorResponse(e) }
}
