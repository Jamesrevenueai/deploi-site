import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { assignThread, markThread, replyToThread } from '@/lib/email/inbox'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * read / unread: mark the conversation.
 * assign { agentId | null }: label it with one of your agents (grants nothing).
 * reply { bodyText, idempotencyKey }: send your reply from the agent's mailbox through the same gates as agent mail.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { key: raw, action } = await ctx.params
    const key = decodeURIComponent(raw)
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    switch (action) {
      case 'read': return NextResponse.json({ ok: true, ...(await markThread(actor, key, true)) })
      case 'unread': return NextResponse.json({ ok: true, ...(await markThread(actor, key, false)) })
      case 'assign': return NextResponse.json({ ok: true, ...(await assignThread(actor, key, typeof body.agentId === 'string' && body.agentId ? body.agentId : null)) })
      case 'reply': return NextResponse.json({ ok: true, ...(await replyToThread(actor, key, { bodyText: String(body.bodyText ?? ''), idempotencyKey: String(body.idempotencyKey ?? '') })) })
      default: throw new HttpError(404, 'not_found', 'unknown action')
    }
  } catch (e) { return errorResponse(e) }
}
