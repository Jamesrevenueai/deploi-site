import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { listFeedback, submitFeedback } from '@/lib/library/feedback'

export const dynamic = 'force-dynamic'

/** { page, mood, message } from the feedback button. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await submitFeedback(actor, body)) })
  } catch (e) { return errorResponse(e) }
}
/** Staff: everything private-beta stores sent. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind !== 'staff') throw new HttpError(403, 'forbidden', 'feedback is read by Deploi staff')
    return NextResponse.json({ ok: true, feedback: await listFeedback(actor) })
  } catch (e) { return errorResponse(e) }
}
