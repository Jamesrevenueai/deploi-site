/**
 * Fallback for installs started outside the Shopify admin (authorization code grant). The embedded
 * app normally installs through Shopify managed installation + token exchange (/api/shopify/session).
 */
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { normalizeShop, authorizeUrl } from '@/lib/connectors/shopify/auth'
import { shopifyConfig } from '@/lib/connectors/shopify/config'

export async function GET(req: Request) {
  if (!shopifyConfig.configured) return NextResponse.json({ ok: false, error: 'shopify_not_configured' }, { status: 503 })
  const shop = normalizeShop(new URL(req.url).searchParams.get('shop'))
  if (!shop) return NextResponse.json({ ok: false, error: 'invalid shop domain' }, { status: 400 })
  const state = randomBytes(16).toString('hex')
  const res = NextResponse.redirect(authorizeUrl(shop, state, `${shopifyConfig.appUrl}/api/shopify/auth/callback`))
  res.cookies.set('deploi_shopify_state', `${shop}:${state}`, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/shopify/auth', maxAge: 600 })
  return res
}
