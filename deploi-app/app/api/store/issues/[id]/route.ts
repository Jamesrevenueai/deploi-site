import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { issueDetail } from '@/lib/engine/queries'

export const dynamic = 'force-dynamic'

/** One issue with its evidence, check explanation, rule, every proposal, execution and audit event. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    const detail = await issueDetail(actor, id)
    if (!detail) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    return NextResponse.json({ ok: true, ...detail, canApprove: actor.kind !== 'staff' })
  } catch (e) { return errorResponse(e) }
}
