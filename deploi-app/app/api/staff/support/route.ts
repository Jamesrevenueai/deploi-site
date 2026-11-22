import { NextResponse } from 'next/server'
import { errorResponse, readJson, HttpError } from '@/lib/store/request'
import { requireStaffApi } from '@/lib/platform/staff'
import { staffGetTicket, staffListTickets, staffReply, staffSetStatus } from '@/lib/support/tickets'

export const dynamic = 'force-dynamic'

/** Staff only: every support request (?status=), or one with its conversation (?ticket=<id>). */
export async function GET(req: Request) {
  try {
    const actor = await requireStaffApi(req)
    const u = new URL(req.url)
    const id = u.searchParams.get('ticket')
    return NextResponse.json({ ok: true, ...(id ? await staffGetTicket(actor, id) : { tickets: await staffListTickets(actor, { status: u.searchParams.get('status') }) }) })
  } catch (e) { return errorResponse(e) }
}

/** Staff only: { action: 'reply', ticketId, message, status? } (emailed to the customer) | { action: 'status', ticketId, status } */
export async function POST(req: Request) {
  try {
    const actor = await requireStaffApi(req, { mutating: true })
    const body = await readJson(req)
    if (body.action === 'reply') return NextResponse.json({ ok: true, ...(await staffReply(actor, body.ticketId, body.message, body.status)) })
    if (body.action === 'status') return NextResponse.json({ ok: true, ...(await staffSetStatus(actor, body.ticketId, body.status)) })
    throw new HttpError(400, 'invalid_input', 'action must be reply or status')
  } catch (e) { return errorResponse(e) }
}
