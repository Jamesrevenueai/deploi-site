import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { approveMessage, declineMessage, editMessage, resolveUnknown, retryMessage } from '@/lib/email/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const hash = (v: unknown) => { const h = String(v ?? ''); if (!/^[0-9a-f]{64}$/.test(h)) throw new HttpError(400, 'invalid_input', 'contentHash is required'); return h }

/**
 * approve { contentHash }: send this exact message now (the hash must match what you saw).
 * edit { contentHash, subject?, bodyText? }: change the text; clears any earlier approval.
 * decline: cancel an unsent message.
 * retry: send a failed message again (after reconnecting, for example).
 * resolve { decision: 'was_sent' | 'not_sent' }: after you checked your Sent folder for a message of unknown delivery.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, action } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    switch (action) {
      case 'approve': return NextResponse.json({ ok: true, ...(await approveMessage(actor, id, hash(body.contentHash))) })
      case 'edit': return NextResponse.json({ ok: true, ...(await editMessage(actor, id, { shownHash: hash(body.contentHash), subject: typeof body.subject === 'string' ? body.subject : undefined, bodyText: typeof body.bodyText === 'string' ? body.bodyText : undefined })) })
      case 'decline': await declineMessage(actor, id); return NextResponse.json({ ok: true })
      case 'retry': return NextResponse.json({ ok: true, ...(await retryMessage(actor, id)) })
      case 'resolve': {
        const d = body.decision
        if (d !== 'was_sent' && d !== 'not_sent') throw new HttpError(400, 'invalid_input', 'decision must be was_sent or not_sent')
        return NextResponse.json({ ok: true, ...(await resolveUnknown(actor, id, d)) })
      }
      default: throw new HttpError(404, 'not_found', 'unknown action')
    }
  } catch (e) { return errorResponse(e) }
}
