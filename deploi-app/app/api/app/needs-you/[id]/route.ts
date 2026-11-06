import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, ipOf, HttpError } from '@/lib/store/request'
import { decideNeedsYou } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Decide one needs-you item: { decision: 'approve' | 'decline', amount? }. Goes through the existing approval logic
 * (lib/approvals decideApproval: organization, role, the version shown, expiry). `amount` only confirms the amount shown.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const raw = (await ctx.params).id
    let id: string
    try { id = decodeURIComponent(raw) } catch { throw new HttpError(404, 'not_found', 'this item is not waiting for a decision') }
    const body = await readJson(req)
    return NextResponse.json({ ok: true, result: await decideNeedsYou(actor, id, body.decision, { amount: body.amount, ip: ipOf(req) }) })
  } catch (e) { return errorResponse(e) }
}
