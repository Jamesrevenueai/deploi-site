/** Start WooCommerce's key-approval flow. Body: { siteUrl }. Returns the URL to send the browser to. */
import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, limitActor } from '@/lib/store/request'
import { requireAgreements } from '@/lib/legal'
import { startAuthorization, purgeStaleStates } from '@/lib/connectors/woocommerce/auth'
import { merchantFor } from '@/lib/connectors/woocommerce/actor'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    await requireAgreements(actor, 'commerce')
    await limitActor('oauth_start', actor)
    const m = await merchantFor(actor)
    const body = await readJson(req)
    await purgeStaleStates().catch(() => 0)
    const r = await startAuthorization({ orgId: m.orgId, actor: m.label, profileId: m.profileId, siteUrl: body.siteUrl })
    return NextResponse.json({ ok: true, authorizeUrl: r.authorizeUrl, siteUrl: r.siteUrl })
  } catch (e) { return errorResponse(e) }
}
