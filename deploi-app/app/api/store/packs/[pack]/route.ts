import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { packView } from '@/lib/packs/dashboard'

export const dynamic = 'force-dynamic'

/** One pack: its agents, what each did (activity and cases), its settings and its records. */
export async function GET(req: Request, ctx: { params: Promise<{ pack: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { pack } = await ctx.params
    return NextResponse.json({ ok: true, ...(await packView(actor, pack)) })
  } catch (e) { return errorResponse(e) }
}
