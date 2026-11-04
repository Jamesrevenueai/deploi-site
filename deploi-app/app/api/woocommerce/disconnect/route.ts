/** Disconnect a WooCommerce store: webhooks deleted, key pair deleted, all work on the store stopped. Body: { connectionId }. */
import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { disconnectStore } from '@/lib/connectors/woocommerce/connect'
import { merchantFor } from '@/lib/connectors/woocommerce/actor'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const m = merchantFor(await resolveActor(req, { mutating: true }))
    const body = await readJson(req)
    if (typeof body.connectionId !== 'string') throw new HttpError(400, 'invalid_input', 'connectionId is required')
    const r = await disconnectStore(m.orgId, body.connectionId, m.label)
    return NextResponse.json({ ok: true, webhooksDeleted: r.webhooksDeleted })
  } catch (e) { return errorResponse(e) }
}
