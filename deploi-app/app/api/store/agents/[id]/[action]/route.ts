import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { grantPolicy, pauseAgent, resumeAgent, revokeAgent } from '@/lib/agents/lifecycle'
import { runAgent } from '@/lib/agents/run'
import { assertMerchant, withActor } from '@/lib/engine/actor'
import { EngineError } from '@/lib/engine/errors'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * grant { policyId, policyHash }: grant the exact authorization version reviewed.
 * pause | resume | revoke { reason? }: pause and revoke stop all writes, including queued ones.
 * run: run the agent now (only an active agent; writes only what its authorization covers).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, action } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    switch (action) {
      case 'grant': {
        const hash = String(body.policyHash ?? '')
        if (!/^[0-9a-f]{64}$/.test(hash) || typeof body.policyId !== 'string') throw new HttpError(400, 'invalid_input', 'policyId and policyHash are required')
        return NextResponse.json({ ok: true, ...(await grantPolicy(actor, id, body.policyId, hash)) })
      }
      case 'pause': return NextResponse.json({ ok: true, ...(await pauseAgent(actor, id)) })
      case 'resume': await resumeAgent(actor, id); return NextResponse.json({ ok: true })
      case 'revoke': return NextResponse.json({ ok: true, ...(await revokeAgent(actor, id, typeof body.reason === 'string' && body.reason.trim() ? body.reason.slice(0, 300) : undefined)) })
      case 'run': {
        const a = await withActor(actor, db => db.one<{ org_id: string }>('select org_id from agents where id = $1', [id]))
        if (!a) throw new EngineError('not_found', 'agent not found')
        assertMerchant(actor, a.org_id)
        const r = await runAgent(id, { trigger: 'manual', actor: actor.label })
        return NextResponse.json({ ok: true, ...r })
      }
      default: throw new HttpError(404, 'not_found', 'unknown action')
    }
  } catch (e) { return errorResponse(e) }
}
