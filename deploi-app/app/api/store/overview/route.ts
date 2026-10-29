import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { overview, listConnections } from '@/lib/engine/queries'
import { allConnectors } from '@/lib/engine/registry'
import { withActor } from '@/lib/engine/actor'
import { admin } from '@/lib/db'
import { storeEligibility } from '@/lib/connectors/eligibility'

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
    // whether Deploi may write to each store, said up front (not discovered after an approval)
    const writes = await admin(async db => {
      const out: Record<string, { enabled: boolean; reason: string; tier: string }> = {}
      for (const c of connections as { id: string; external_id: string; is_synthetic: boolean }[]) {
        const e = await storeEligibility(db, c.external_id, c.is_synthetic)
        out[c.id] = { enabled: e.liveWrites, reason: e.reason, tier: e.tier }
      }
      return out
    })
    const platforms = allConnectors().map(c => ({ platform: c.platform, status: c.operational ? 'operational' : 'planned' }))
    return NextResponse.json({ ok: true, actor: { kind: actor.kind, label: actor.label, canApprove: actor.kind !== 'staff' }, org, connections, writes, overview: counts, platforms })
  } catch (e) { return errorResponse(e) }
}
