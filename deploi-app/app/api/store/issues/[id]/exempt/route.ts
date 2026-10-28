import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, ipOf } from '@/lib/store/request'
import { exemptProduct } from '@/lib/engine/review'

/** Exempt the issue's product from its check (recorded in the merchant rule). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    await exemptProduct(actor, id, { ip: ipOf(req) })
    return NextResponse.json({ ok: true })
  } catch (e) { return errorResponse(e) }
}
