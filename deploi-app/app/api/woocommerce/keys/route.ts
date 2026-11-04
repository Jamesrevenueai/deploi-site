/** Manual fallback: paste a Read/Write key pair. Validated by a live read before anything is stored. Body: { siteUrl, consumerKey, consumerSecret }. */
import { NextResponse, after } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { connectStore } from '@/lib/connectors/woocommerce/connect'
import { merchantFor } from '@/lib/connectors/woocommerce/actor'
import { runScan } from '@/lib/engine/scan'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const m = merchantFor(await resolveActor(req, { mutating: true }))
    const body = await readJson(req)
    const creds = { consumerKey: String(body.consumerKey ?? '').trim(), consumerSecret: String(body.consumerSecret ?? '').trim() }
    const r = await connectStore({ orgId: m.orgId, actor: m.label, siteUrl: String(body.siteUrl ?? ''), creds, permissions: 'read_write', via: 'manual' })
    after(() => runScan(r.connectionId, { trigger: 'install', actor: m.label }).then(() => undefined, () => undefined))
    return NextResponse.json({ ok: true, connectionId: r.connectionId, created: r.created, webhooksError: r.webhooksError })
  } catch (e) { return errorResponse(e) }
}
