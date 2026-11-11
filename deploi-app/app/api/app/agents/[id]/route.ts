import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { agentDashboard } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'

/** One agent: the TeamAgent, four stats, what it may do (from its grants), its work with proof and its instructions. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const id = agentIdParam((await ctx.params).id)
    return NextResponse.json({ ok: true, dashboard: await agentDashboard(actor, id) })
  } catch (e) { return errorResponse(e) }
}
