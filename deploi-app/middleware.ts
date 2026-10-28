import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { resolveAuthMode } from './lib/auth-guard'

/** Keeps Supabase auth cookies fresh. Authorization itself happens in the layouts (requireRole). */
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/** Embedded Shopify pages may only be framed by the Shopify admin and the merchant's own shop. */
function embeddedHeaders(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get('shop')?.toLowerCase() ?? ''
  const ancestors = SHOP.test(shop) ? `https://${shop} https://admin.shopify.com` : 'https://*.myshopify.com https://admin.shopify.com'
  const res = NextResponse.next()
  res.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors};`)
  return res
}

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/shopify' || req.nextUrl.pathname.startsWith('/shopify/')) return embeddedHeaders(req)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key || resolveAuthMode(process.env) === 'dev') return NextResponse.next()
  let res = NextResponse.next({ request: req })
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: all => {
        all.forEach(({ name, value }) => req.cookies.set(name, value))
        res = NextResponse.next({ request: req })
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
      },
    },
  })
  await sb.auth.getUser()
  return res
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/public|api/webhooks|api/cron|api/shopify).*)'] }
