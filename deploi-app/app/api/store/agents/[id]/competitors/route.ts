import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { competitorOverview } from '@/lib/competitors/queries'

export const dynamic = 'force-dynamic'

/** Watched stores with source health, findings (newest first), sources and providers. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await competitorOverview(actor, id)) })
  } catch (e) { return errorResponse(e) }
}
