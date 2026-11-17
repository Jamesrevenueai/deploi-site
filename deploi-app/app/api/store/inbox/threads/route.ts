import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { listInboxThreads } from '@/lib/email/inbox'

export const dynamic = 'force-dynamic'

/** The customer inbox: every agent mailbox's conversations, newest first. ?filter=all|unread|assigned &agentId= */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams
    const filter = q.get('filter') === 'unread' ? 'unread' : q.get('filter') === 'assigned' ? 'assigned' : 'all'
    return NextResponse.json({ ok: true, threads: await listInboxThreads(actor, { filter, agentId: q.get('agentId') }) })
  } catch (e) { return errorResponse(e) }
}
