import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { teamView } from '@/lib/library/switches'
import { assertEmbeddedFeature, fromShopifyAdmin } from '@/lib/store/embedded-gate'
import { shopifyLibraryAgentKeys } from '@/lib/shopify/embedded'

export const dynamic = 'force-dynamic'

/** The team: every library agent with its tier lock, switch, permission, grants, counts; usage; custom agents; onboarding state. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    assertEmbeddedFeature(actor, 'team')
    const view = await teamView(actor)
    // inside Shopify: only the library agents marked ready for Shopify, and no build-your-own
    if (fromShopifyAdmin(actor)) {
      const ready = new Set(shopifyLibraryAgentKeys())
      return NextResponse.json({ ok: true, ...view, agents: view.agents.filter(a => ready.has(a.key)), buildYourOwn: { allowed: false, agents: [] } })
    }
    return NextResponse.json({ ok: true, ...view })
  } catch (e) { return errorResponse(e) }
}
