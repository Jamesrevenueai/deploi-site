import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { resolveAuthMode } from './lib/auth-guard'
import { appBridgeFirst } from './lib/shopify/head'
import { cspHeaders, cspMode, newNonce } from './lib/security/csp'

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

/**
 * A fresh nonce and the CSP for this page (lib/security/csp.ts). The nonce reaches the page through two
 * request headers: `Content-Security-Policy` (Next.js reads the nonce from it and puts it on every script
 * it emits) and `x-nonce` (the root layout puts it on the App Bridge script).
 */
function policyFor(req: NextRequest, embedded: boolean) {
  const nonce = newNonce()
  const headers = cspHeaders({
    nonce, embedded, frameAncestors: frameAncestors(req.nextUrl.pathname, embedded ? req.nextUrl.searchParams.get('shop') : null),
    mode: cspMode(), dev: process.env.NODE_ENV !== 'production', supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, reportUri: process.env.CSP_REPORT_URI || undefined,
  })
  /** the incoming request headers plus the nonce headers, for NextResponse.next({ request }) */
  const forward = (extra: Record<string, string> = {}) => {
    const h = new Headers(req.headers)
    h.set('x-nonce', nonce)
    h.delete('content-security-policy'); h.delete('content-security-policy-report-only')
    for (const [k, v] of headers) h.set(k, v)
    for (const [k, v] of Object.entries(extra)) h.set(k, v)
    return h
  }
  const apply = (res: NextResponse) => { for (const [k, v] of headers) res.headers.set(k, v); return res }
  return { forward, apply }
}

/** A full HTML page load of the embedded app (not a client-side RSC navigation or prefetch). */
function isDocumentLoad(req: NextRequest): boolean {
  return req.method === 'GET' && !req.headers.has(INTERNAL) && !req.headers.has('rsc') && !req.headers.has('next-router-prefetch')
    && (req.headers.get('accept') ?? '').includes('text/html')
}

async function embeddedHeaders(req: NextRequest) {
  if (isDocumentLoad(req)) {
    // Render the page (second pass through here, marked internal), then move App Bridge to the top of <head>:
    // Shopify requires its script tag before any other script, and Next.js always emits its own first.
    // The second pass makes its own nonce and CSP; the document keeps exactly that CSP, so the nonce in the
    // header is the one in the HTML. Forging the marker only skips this reordering; a CSP is set on every pass.
    const inner = new Headers(req.headers)
    inner.set(INTERNAL, '1')
    const r = await fetch(req.nextUrl, { headers: inner, redirect: 'manual' })
    const type = r.headers.get('content-type') ?? ''
    if (r.status === 200 && type.includes('text/html')) {
      const headers = new Headers(r.headers)
      headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('transfer-encoding')
      // the inner pass always sets it; never let the document go out without framing limits
      if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', frameAncestors(req.nextUrl.pathname, req.nextUrl.searchParams.get('shop')))
      return new NextResponse(appBridgeFirst(await r.text()), { status: 200, headers })
    }
  }
  // tells the root layout to render the App Bridge meta and script in <head>
  const p = policyFor(req, true)
  return p.apply(NextResponse.next({ request: { headers: p.forward({ 'x-deploi-embedded': '1' }) } }))
}

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/shopify' || req.nextUrl.pathname.startsWith('/shopify/')) return embeddedHeaders(req)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const p = policyFor(req, false)
  if (!url || !key || resolveAuthMode(process.env) === 'dev') return p.apply(NextResponse.next({ request: { headers: p.forward() } }))
  let res = NextResponse.next({ request: { headers: p.forward() } })
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: all => {
        // req.cookies.set rewrites the request's cookie header, which forward() copies
        all.forEach(({ name, value }) => req.cookies.set(name, value))
        res = NextResponse.next({ request: { headers: p.forward() } })
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
      },
    },
  })
  await sb.auth.getUser()
  return p.apply(res)
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/public|api/webhooks|api/cron|api/shopify).*)'] }
