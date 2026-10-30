/**
 * Fallback for installs started outside the Shopify admin (authorization code grant). The embedded
 * app normally installs through Shopify managed installation + token exchange (/api/shopify/session).
 * `request=write_products` also asks for declared optional scopes, as a full-page alternative to the
 * in-app grant (for browsers that block the embedded frame's cookies).
 */
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { normalizeShop, authorizeUrl } from '@/lib/connectors/shopify/auth'
import { shopifyConfig } from '@/lib/connectors/shopify/config'
import { authorizeScopes } from '@/lib/connectors/shopify/scopes'

export async function GET(req: Request) {
  if (!shopifyConfig.configured) return NextResponse.json({ ok: false, error: 'shopify_not_configured' }, { status: 503 })
  const params = new URL(req.url).searchParams
  const shop = normalizeShop(params.get('shop'))
  if (!shop) return NextResponse.json({ ok: false, error: 'invalid shop domain' }, { status: 400 })
  const state = randomBytes(16).toString('hex')
  const res = NextResponse.redirect(authorizeUrl(shop, state, `${shopifyConfig.appUrl}/api/shopify/auth/callback`, authorizeScopes(params.get('request'))))
  res.cookies.set('deploi_shopify_state', `${shop}:${state}`, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/shopify/auth', maxAge: 600 })
  return res
}
