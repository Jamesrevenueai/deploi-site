import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, ipOf } from '@/lib/store/request'
import { retryExecution } from '@/lib/engine/execute'

export const maxDuration = 60

/** Retry a failed or unconfirmed execution under the same approval (re-reads before writing). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    const r = await retryExecution(actor, id, { ip: ipOf(req) })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
