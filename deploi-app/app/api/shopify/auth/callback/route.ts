import { NextResponse, after } from 'next/server'
import { cookies } from 'next/headers'
import { timingSafeEqual } from 'node:crypto'
import { normalizeShop, verifyQueryHmac, exchangeAuthorizationCode } from '@/lib/connectors/shopify/auth'
import { shopifyConfig } from '@/lib/connectors/shopify/config'
import { ensureInstalled } from '@/lib/connectors/shopify/install'
import { runScan } from '@/lib/engine/scan'
import { log } from '@/lib/log'
import '@/lib/connectors'

/** Authorization code callback: HMAC, state and shop are verified before the code is exchanged. */
export async function GET(req: Request) {
  if (!shopifyConfig.configured) return NextResponse.json({ ok: false, error: 'shopify_not_configured' }, { status: 503 })
  const q = new URL(req.url).searchParams
  const shop = normalizeShop(q.get('shop'))
  const code = q.get('code')
  const state = q.get('state') ?? ''
  const store = await cookies()
  const expected = store.get('deploi_shopify_state')?.value ?? ''
  const want = `${shop}:${state}`
  const stateOk = expected.length === want.length && timingSafeEqual(Buffer.from(expected), Buffer.from(want))
  if (!shop || !code || !stateOk || !verifyQueryHmac(q, shopifyConfig.apiSecret)) {
    log.warn('shopify.oauth.callback_rejected', { shop_valid: Boolean(shop), state_ok: stateOk })
    return NextResponse.json({ ok: false, error: 'invalid callback' }, { status: 400 })
  }
  store.delete('deploi_shopify_state')
  const r = await ensureInstalled(shop, '', { exchange: s => exchangeAuthorizationCode(s, code), force: true })
  after(() => runScan(r.connectionId, { trigger: 'install', actor: `shopify:${shop}:install` }).then(() => undefined, () => undefined))
  return NextResponse.redirect(`https://${shop}/admin/apps/${shopifyConfig.apiKey}`)
}
