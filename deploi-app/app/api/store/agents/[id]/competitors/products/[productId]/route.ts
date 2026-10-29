import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { competitorProductHistory } from '@/lib/competitors/queries'

export const dynamic = 'force-dynamic'

/** Price and availability history of one watched product. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; productId: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id, productId } = await ctx.params
    return NextResponse.json({ ok: true, ...(await competitorProductHistory(actor, id, productId)) })
  } catch (e) { return errorResponse(e) }
}
