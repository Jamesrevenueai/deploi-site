/**
 * WooCommerce posts the approved key pair here (server to server, JSON). Answers 200 only when the state
 * verified and the keys were stored encrypted; any other answer makes WooCommerce delete the key.
 * The key is validated and the connection created after the response (see lib/connectors/woocommerce/auth.ts).
 * Nothing from the body is logged. Limited per client IP (bucket woo_callback): a refused callback makes
 * WooCommerce delete the key, and the merchant simply connects again.
 */
import { NextResponse, after } from 'next/server'
import { receiveCallback, finalizeAuthorization } from '@/lib/connectors/woocommerce/auth'
import { runScan } from '@/lib/engine/scan'
import { log } from '@/lib/log'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'
import '@/lib/connectors'
import { requestDiscovery } from '@/lib/discovery/jobs'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const limited = await hitByIp('woo_callback', req)
  if (!limited.allowed) return tooManyRequests(limited)
  let body: unknown = null
  try { body = JSON.parse(await req.text()) } catch { body = null }
  const r = await receiveCallback(body).catch(e => { log.error('woocommerce.callback.failed', { error: (e as Error).message.slice(0, 120) }); return { status: 400 as const, stateId: null, reason: 'error' } })
  if (r.status !== 200 || !r.stateId) {
    log.warn('woocommerce.callback.refused', { reason: r.reason })
    return NextResponse.json({ ok: false, error: r.reason }, { status: 400 })
  }
  const stateId = r.stateId
  after(async () => {
    const f = await finalizeAuthorization(stateId).catch(() => null)
    if (f?.status === 'connected' && f.connectionId) await runScan(f.connectionId, { trigger: 'install', actor: 'woocommerce:install' }).catch(() => undefined)
    if (f?.status === 'connected' && f.connectionId) await requestDiscovery(f.orgId, `woocommerce:${f.connectionId}`)
  })
  return NextResponse.json({ ok: true })
}
