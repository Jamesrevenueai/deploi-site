import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { getInboxThread } from '@/lib/email/inbox'

export const dynamic = 'force-dynamic'

/** One conversation in order, inbound and outbound, with the exact text (merchant users of the organization only). */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { key } = await ctx.params
    return NextResponse.json({ ok: true, ...(await getInboxThread(actor, decodeURIComponent(key))) })
  } catch (e) { return errorResponse(e) }
}
