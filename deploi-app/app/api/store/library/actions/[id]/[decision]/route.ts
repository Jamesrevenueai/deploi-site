import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { approveAction, declineAction } from '@/lib/library/actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** approve: a store write runs now and the fresh read is the proof; a message is marked approved (never sent here). decline { reason? }. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; decision: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, decision } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (decision === 'approve') return NextResponse.json({ ok: true, ...(await approveAction(actor, id)) })
    if (decision === 'decline') { await declineAction(actor, id, typeof body.reason === 'string' ? body.reason : undefined); return NextResponse.json({ ok: true, status: 'declined' }) }
    throw new HttpError(404, 'not_found', 'unknown decision')
  } catch (e) { return errorResponse(e) }
}
