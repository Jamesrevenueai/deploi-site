import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { approveAction, declineAction } from '@/lib/library/actions'
import { assertEmbeddedLibraryAgent, fromShopifyAdmin } from '@/lib/store/embedded-gate'
import { withActor } from '@/lib/engine/actor'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** approve: a store write runs now and the fresh read is the proof; a message is marked approved (never sent here). decline { reason? }. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; decision: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, decision } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (fromShopifyAdmin(actor)) {
      // inside Shopify only actions of library agents shown there can be decided
      const row = /^[0-9a-f-]{36}$/i.test(id) ? await withActor(actor, db => db.one<{ agent_key: string }>('select agent_key from library_actions where id = $1', [id])) : null
      if (!row) throw new HttpError(404, 'not_found', 'not found')
      assertEmbeddedLibraryAgent(actor, row.agent_key)
    }
    if (decision === 'approve') return NextResponse.json({ ok: true, ...(await approveAction(actor, id)) })
    if (decision === 'decline') { await declineAction(actor, id, typeof body.reason === 'string' ? body.reason : undefined); return NextResponse.json({ ok: true, status: 'declined' }) }
    throw new HttpError(404, 'not_found', 'unknown decision')
  } catch (e) { return errorResponse(e) }
}
