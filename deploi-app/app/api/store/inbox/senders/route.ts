import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { blockSender, listSenderRules, unblockSender } from '@/lib/email/sender-policy'

export const dynamic = 'force-dynamic'

/** The organization's blocked senders and the senders whose first reply was approved. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, rules: await listSenderRules(actor) })
  } catch (e) { return errorResponse(e) }
}

/** Body { op: 'block' | 'unblock', pattern: 'a@b.example' | '@b.example', reason? } (owners and admins). */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const b = await readJson(req)
    if (b.op === 'block') return NextResponse.json({ ok: true, ...(await blockSender(actor, String(b.pattern ?? ''), typeof b.reason === 'string' ? b.reason : null)) })
    if (b.op === 'unblock') return NextResponse.json({ ok: true, ...(await unblockSender(actor, String(b.pattern ?? ''))) })
    throw new HttpError(400, 'invalid_input', 'op must be block or unblock')
  } catch (e) { return errorResponse(e) }
}
