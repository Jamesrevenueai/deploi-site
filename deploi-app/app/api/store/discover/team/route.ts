import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { requireAgreements } from '@/lib/legal'
import { discoverView, grantShownTeam, setUpTeam } from '@/lib/discovery'
import { EngineError } from '@/lib/engine/errors'
import type { GrantRequest } from '@/lib/discovery/team'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * The recommended AI team.
 *  {} or { op: 'create', only?: [template] }   create every recommended agent that can be created now, at
 *                                               drafts only (idempotent: never a second agent). Each item
 *                                               carries its pending policy: id, hash and plain summary.
 *  { op: 'grant', grants: [{ agentId, policyId?, policyHash }] }
 *                                               "grant all shown": each is granted only if the hash is the
 *                                               pending version's and it is drafts only; others are refused.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new EngineError('forbidden', "Deploi staff cannot set up or grant a customer's agents")
    const body = await readJson(req)
    const op = body.op ?? 'create'
    const view = await discoverView(actor)
    for (const suite of new Set(view.team.map(t => t.suite))) await requireAgreements(actor, suite)
    if (op === 'create') {
      const only = Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === 'string').slice(0, 25) : undefined
      const items = await setUpTeam(actor, { only })
      return NextResponse.json({ ok: true, items })
    }
    if (op === 'grant') {
      if (!Array.isArray(body.grants)) throw new HttpError(400, 'invalid_input', 'grants must list { agentId, policyHash } for every agent you reviewed')
      const results = await grantShownTeam(actor, body.grants as GrantRequest[])
      return NextResponse.json({ ok: true, results, granted: results.filter(r => r.ok).length, refused: results.filter(r => !r.ok).length })
    }
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return errorResponse(e) }
}
