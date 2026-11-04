import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { orgControl } from '@/lib/engine/kill-switch'
import { clearAgentStop, stopAllAgents } from '@/lib/agents/lifecycle'

export const dynamic = 'force-dynamic'

/** The organization's "stop all agents" switch. GET: its state. POST { action: 'stop', reason } | { action: 'clear' }. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const c = await withActor(actor, db => orgControl(db, actor.orgId))
    return NextResponse.json({ ok: true, agentsStopped: Boolean(c?.agents_stopped), control: c })
  } catch (e) { return errorResponse(e) }
}

export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.action === 'stop') return NextResponse.json({ ok: true, ...(await stopAllAgents(actor, String(body.reason ?? ''))) })
    if (body.action === 'clear') return NextResponse.json({ ok: true, ...(await clearAgentStop(actor)) })
    throw new HttpError(400, 'invalid_input', "action must be 'stop' or 'clear'")
  } catch (e) { return errorResponse(e) }
}
