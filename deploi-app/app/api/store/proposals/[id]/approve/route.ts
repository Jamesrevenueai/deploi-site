import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, ipOf, HttpError } from '@/lib/store/request'
import { approveAndExecute } from '@/lib/engine/execute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Approve one exact change and run it. Body: { changeHash } — the hash the merchant was shown.
 * Returns the execution outcome: verified, failed, blocked or stale (never a silent success).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    const body = await readJson(req)
    const hash = String(body.changeHash ?? '')
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'invalid_input', 'changeHash is required')
    const r = await approveAndExecute(actor, id, hash, { ip: ipOf(req) })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
