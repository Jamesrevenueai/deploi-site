import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { appBridgeFirst } from './lib/shopify/head'

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

const INTERNAL = 'x-deploi-head-pass'

/** A full HTML page load of the embedded app (not a client-side RSC navigation or prefetch). */
function isDocumentLoad(req: NextRequest): boolean {
  return req.method === 'GET' && !req.headers.has(INTERNAL) && !req.headers.has('rsc') && !req.headers.has('next-router-prefetch')
    && (req.headers.get('accept') ?? '').includes('text/html')
}

async function embeddedHeaders(req: NextRequest) {
  const csp = frameAncestors(req.nextUrl.pathname, req.nextUrl.searchParams.get('shop'))
  if (isDocumentLoad(req)) {
    // Render the page (second pass through here, marked internal), then move App Bridge to the top of <head>:
    // Shopify requires its script tag before any other script, and Next.js always emits its own first.
    // Forging the marker only skips this reordering; the CSP below is applied on every pass.
    const inner = new Headers(req.headers)
    inner.set(INTERNAL, '1')
    const r = await fetch(req.nextUrl, { headers: inner, redirect: 'manual' })
    const type = r.headers.get('content-type') ?? ''
    if (r.status === 200 && type.includes('text/html')) {
      const headers = new Headers(r.headers)
      headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('transfer-encoding')
      headers.set('Content-Security-Policy', csp)
      return new NextResponse(appBridgeFirst(await r.text()), { status: 200, headers })
    }
  }
  // tells the root layout to render the App Bridge meta and script in <head>
  const headers = new Headers(req.headers)
  headers.set('x-deploi-embedded', '1')
  const res = NextResponse.next({ request: { headers } })
  res.headers.set('Content-Security-Policy', csp)
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
