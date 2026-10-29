import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { competitorProducts } from '@/lib/competitors/queries'

export const dynamic = 'force-dynamic'

/** Products seen at watched stores. ?q=<word>&store=<id> */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    const sp = new URL(req.url).searchParams
    const store = sp.get('store')
    return NextResponse.json({ ok: true, products: await competitorProducts(actor, id, { q: sp.get('q'), storeId: store && /^[0-9a-f-]{36}$/i.test(store) ? store : null }) })
  } catch (e) { return errorResponse(e) }
}
