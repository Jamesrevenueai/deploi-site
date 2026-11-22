import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { foundSummary } from '@/lib/autonomy/on-connect'

export const dynamic = 'force-dynamic'

/** What the agents found since the latest connection (counts only): found, fixed, in progress, needs you, queued. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, summary: null })
    const summary = await withActor(actor, db => foundSummary(db, actor.orgId))
    return NextResponse.json({ ok: true, summary })
  } catch (e) { return errorResponse(e) }
}
