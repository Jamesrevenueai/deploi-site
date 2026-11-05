import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { createTicket, customerReply, getTicket, listTickets } from '@/lib/support/tickets'

export const dynamic = 'force-dynamic'

/** Your organization's support requests (?ticket=<id>: one, with its conversation). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const id = new URL(req.url).searchParams.get('ticket')
    return NextResponse.json({ ok: true, ...(id ? await getTicket(actor, id) : { tickets: await listTickets(actor) }) })
  } catch (e) { return errorResponse(e) }
}

/** { action: 'create', category, message, subject?, caseRef?, page? } | { action: 'reply', ticketId, message } */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.action === 'create') return NextResponse.json({ ok: true, ...(await createTicket(actor, { category: body.category, message: body.message, subject: body.subject, caseRef: body.caseRef, page: body.page })) })
    if (body.action === 'reply') return NextResponse.json({ ok: true, ...(await customerReply(actor, body.ticketId, body.message)) })
    throw new HttpError(400, 'invalid_input', 'action must be create or reply')
  } catch (e) { return errorResponse(e) }
}
