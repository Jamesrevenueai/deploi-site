import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { agentIdParam } from '@/lib/app/request'
import { runCheck } from '@/lib/app/run-check'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Run a check now: runs the agent once (members and above). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const id = agentIdParam((await ctx.params).id)
    return NextResponse.json({ ok: true, result: await runCheck(actor, id) })
  } catch (e) { return errorResponse(e) }
}
