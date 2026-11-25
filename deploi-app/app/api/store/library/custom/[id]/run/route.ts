import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { assertNotEmbedded } from '@/lib/store/embedded-gate'
import { runCustomAgent } from '@/lib/library/custom'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    assertNotEmbedded(actor) // build your own is not offered inside Shopify
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await runCustomAgent(actor, id)) })
  } catch (e) { return errorResponse(e) }
}
