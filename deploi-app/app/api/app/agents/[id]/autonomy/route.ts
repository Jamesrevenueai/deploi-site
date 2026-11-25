import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { setAgentAutonomy } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** { autonomy: 'ask_first' | 'act_then_tell' | 'autonomous' }. Owners and admins; applied to the agent's own grants. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const id = agentIdParam((await ctx.params).id)
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await setAgentAutonomy(actor, id, body.autonomy)) })
  } catch (e) { return errorResponse(e) }
}
