import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { agentMailThreads } from '@/lib/email/threads'

export const dynamic = 'force-dynamic'

/** The agent mailbox as conversations: sent messages with matched replies, forwards and quarantined mail. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await agentMailThreads(actor, id)) })
  } catch (e) { return errorResponse(e) }
}
