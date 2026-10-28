import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/** Keeps Supabase auth cookies fresh. Authorization itself happens in the layouts (requireRole). */
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/**
 * Framing policy (Shopify rejects missing or wildcard directives for embedded apps):
 * embedded pages may be framed only by the Shopify admin and the requesting shop; every other page
 * may not be framed at all.
 */
export function frameAncestors(pathname: string, shopParam: string | null): string {
  const embedded = pathname === '/shopify' || pathname.startsWith('/shopify/')
  if (!embedded) return "frame-ancestors 'none';"
  const shop = (shopParam ?? '').toLowerCase()
  return SHOP.test(shop) ? `frame-ancestors https://${shop} https://admin.shopify.com;` : 'frame-ancestors https://admin.shopify.com;'
}

function embeddedHeaders(req: NextRequest) {
  const res = NextResponse.next()
  res.headers.set('Content-Security-Policy', frameAncestors(req.nextUrl.pathname, req.nextUrl.searchParams.get('shop')))
  return res
}

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/shopify' || req.nextUrl.pathname.startsWith('/shopify/')) return embeddedHeaders(req)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const csp = frameAncestors(req.nextUrl.pathname, null)
  if (!url || !key || process.env.AUTH_MODE === 'dev') { const r = NextResponse.next(); r.headers.set('Content-Security-Policy', csp); return r }
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
  res.headers.set('Content-Security-Policy', csp)
  return res
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/public|api/webhooks|api/cron|api/shopify).*)'] }
