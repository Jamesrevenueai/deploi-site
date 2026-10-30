import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { runCustomAgent } from '@/lib/library/custom'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await runCustomAgent(actor, id)) })
  } catch (e) { return errorResponse(e) }
}
