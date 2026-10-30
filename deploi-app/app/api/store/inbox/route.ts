import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { listInbox } from '@/lib/agents/inbox'

export const dynamic = 'force-dynamic'

/** Everything agents are waiting on the merchant for: exact store changes and emails (approve or reject). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await listInbox(actor)) })
  } catch (e) { return errorResponse(e) }
}
