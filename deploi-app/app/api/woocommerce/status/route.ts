/** The organization's WooCommerce connections and its latest authorization attempt. Never returns key material. */
import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { wooStatusFor } from '@/lib/connectors/woocommerce/status'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, connections: [], lastAttempt: null, canConnect: false })
    return NextResponse.json({ ok: true, ...(await wooStatusFor(actor.orgId)), canConnect: true })
  } catch (e) { return errorResponse(e) }
}
