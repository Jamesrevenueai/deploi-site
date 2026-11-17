import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { listActions } from '@/lib/library/actions'
import { assertEmbeddedFeature, assertEmbeddedLibraryAgent, fromShopifyAdmin } from '@/lib/store/embedded-gate'
import { isShopifyLibraryAgent } from '@/lib/shopify/embedded'

export const dynamic = 'force-dynamic'

/** The approval queue and log across the team. ?agent=<key>&status=draft */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'the team belongs to a merchant organization')
    const u = new URL(req.url)
    assertEmbeddedFeature(actor, 'team')
    const agentKey = u.searchParams.get('agent')
    if (agentKey) assertEmbeddedLibraryAgent(actor, agentKey)
    const actions = await listActions(actor, actor.orgId, { agentKey, status: u.searchParams.get('status') })
    return NextResponse.json({ ok: true, actions: fromShopifyAdmin(actor) ? actions.filter(a => isShopifyLibraryAgent(a.agent_key)) : actions })
  } catch (e) { return errorResponse(e) }
}
