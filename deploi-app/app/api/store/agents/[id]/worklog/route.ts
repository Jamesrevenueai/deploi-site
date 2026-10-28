import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { agentWorkLog } from '@/lib/agents/worklog'
import { listTasks } from '@/lib/agents/tasks'

export const dynamic = 'force-dynamic'

/** The agent's work log (what, when, why, which permission) and its plain-language tasks. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    const [log, tasks] = await Promise.all([agentWorkLog(actor, id), listTasks(actor, id)])
    return NextResponse.json({ ok: true, log, tasks })
  } catch (e) { return errorResponse(e) }
}
