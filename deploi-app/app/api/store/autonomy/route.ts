import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, ipOf } from '@/lib/store/request'
import { listModes, setMode } from '@/lib/autonomy/settings'

export const dynamic = 'force-dynamic'

/** How the organization's agents act, per action type: "Do it and tell me" (act_and_tell) or "Ask me first" (ask_first). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: false, error: 'invalid_input', message: 'staff view an organization from the staff console' }, { status: 400 })
    return NextResponse.json({ ok: true, ...(await listModes(actor)) })
  } catch (e) { return errorResponse(e) }
}

/** { actionType, mode: 'act_and_tell' | 'ask_first' }. Owners and admins; audited. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await setMode(actor, body.actionType, body.mode, { ip: ipOf(req) })) })
  } catch (e) { return errorResponse(e) }
}
