import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { cancelDeletion, deletionStatus, requestDeletion } from '@/lib/platform/deletion'

export const dynamic = 'force-dynamic'

/** The organization's deletion request (if any) and the cooling-off period. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await deletionStatus(actor)) })
  } catch (e) { return errorResponse(e) }
}

/** { action: 'request' | 'cancel' }. Owner only. Nothing is deleted before the cooling-off period ends. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.action === 'request') return NextResponse.json({ ok: true, request: await requestDeletion(actor) })
    if (body.action === 'cancel') return NextResponse.json({ ok: true, request: await cancelDeletion(actor) })
    throw new HttpError(400, 'invalid_input', 'action must be request or cancel')
  } catch (e) { return errorResponse(e) }
}
