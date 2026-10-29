import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { listActions } from '@/lib/library/actions'

export const dynamic = 'force-dynamic'

/** The approval queue and log across the team. ?agent=<key>&status=draft */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'the team belongs to a merchant organization')
    const u = new URL(req.url)
    return NextResponse.json({ ok: true, actions: await listActions(actor, actor.orgId, { agentKey: u.searchParams.get('agent'), status: u.searchParams.get('status') }) })
  } catch (e) { return errorResponse(e) }
}
