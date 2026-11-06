import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { releaseInbound } from '@/lib/email/sender-policy'

export const dynamic = 'force-dynamic'

/**
 * release: let one quarantined message through to Email Operations (owners and admins). A sender that is still
 * new stays "first contact": the reply to it waits for your approval whatever the agent's permission.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, action } = await ctx.params
    if (action === 'release') return NextResponse.json({ ok: true, ...(await releaseInbound(actor, id)) })
    throw new HttpError(404, 'not_found', 'unknown action')
  } catch (e) { return errorResponse(e) }
}
