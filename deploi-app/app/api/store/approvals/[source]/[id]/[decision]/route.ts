import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, ipOf, HttpError } from '@/lib/store/request'
import { decideApproval } from '@/lib/approvals'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Decide one item: approve or reject. Body: { version, edits?, reason? } where version is the content
 * hash you were shown. A stale version, an expired item or another organization's item is refused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ source: string; id: string; decision: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { source, id, decision } = await ctx.params
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(404, 'not_found', 'unknown decision')
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'invalid_input', 'invalid id')
    const body = await readJson(req)
    const version = String(body.version ?? '')
    if (!/^[0-9a-f]{64}$/.test(version)) throw new HttpError(400, 'invalid_input', 'version is required (the content hash you were shown)')
    const edits = body.edits && typeof body.edits === 'object' ? body.edits as Record<string, unknown> : undefined
    const r = await decideApproval(actor, source, id, decision, { version, edits, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined, ip: ipOf(req) })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
