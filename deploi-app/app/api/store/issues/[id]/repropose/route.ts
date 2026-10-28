import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, ipOf } from '@/lib/store/request'
import { confirmReproposal } from '@/lib/engine/review'
import { runScan } from '@/lib/engine/scan'
import { withActor } from '@/lib/engine/actor'

/** After a revert, confirm Deploi may propose the change again; re-reads the record straight away. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    await confirmReproposal(actor, id, { ip: ipOf(req) })
    const i = await withActor(actor, db => db.one<{ connection_id: string; resource_id: string }>('select connection_id, resource_id from issues where id = $1', [id]))
    if (i) await runScan(i.connection_id, { trigger: 'manual', resourceIds: [i.resource_id], actor: actor.label })
    return NextResponse.json({ ok: true })
  } catch (e) { return errorResponse(e) }
}
