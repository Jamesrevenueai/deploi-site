import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { stopAllAgents, clearStop } from '@/lib/store/control-room'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Emergency stop: pause every agent in the organization (queued changes and emails are cancelled) and
 * switch off the library agents. Body { confirm: 'stop' } so a stray request cannot trigger it; { action: 'clear' } turns the stop off (nothing restarts by itself).
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.action === 'clear') return NextResponse.json({ ok: true, ...(await clearStop(actor)) })
    if (body.confirm !== 'stop') throw new HttpError(400, 'invalid_input', 'confirm the stop with { confirm: "stop" }')
    return NextResponse.json({ ok: true, ...(await stopAllAgents(actor)) })
  } catch (e) { return errorResponse(e) }
}
