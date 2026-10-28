import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { overview, listConnections } from '@/lib/engine/queries'
import { allConnectors } from '@/lib/engine/registry'
import { withActor } from '@/lib/engine/actor'

export const dynamic = 'force-dynamic'

/** Store overview: organization, connections, counts by outcome, last scan, platform availability. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const [connections, counts, org] = await Promise.all([
      listConnections(actor),
      overview(actor),
      actor.kind === 'staff' ? null : withActor(actor, db => db.one<{ id: string; name: string; timezone: string }>('select id, name, timezone from agencies where id = current_org_id()')),
    ])
    const platforms = allConnectors().map(c => ({ platform: c.platform, status: c.operational ? 'operational' : 'planned' }))
    return NextResponse.json({ ok: true, actor: { kind: actor.kind, label: actor.label, canApprove: actor.kind !== 'staff' }, org, connections, overview: counts, platforms })
  } catch (e) { return errorResponse(e) }
}
