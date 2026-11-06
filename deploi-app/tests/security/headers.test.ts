/**
 * Security headers: every response gets HSTS, nosniff, a strict referrer policy and a restrictive
 * Permissions-Policy; every page except the embedded Shopify app refuses framing (X-Frame-Options and
 * frame-ancestors 'none'); the embedded app may be framed only by the Shopify admin and the requesting shop.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import nextConfig from '../../next.config'
import { frameAncestors } from '../../middleware'

type H = { source: string; headers: { key: string; value: string }[] }

describe('security headers', async () => {
  const rules = (await nextConfig.headers!()) as H[]
  const forPath = (path: string) => rules.filter(r => new RegExp(`^${r.source}$`).test(path)).flatMap(r => r.headers)
  const get = (path: string, key: string) => forPath(path).find(h => h.key.toLowerCase() === key.toLowerCase())?.value

  it('HSTS (>= 1 year, subdomains), nosniff, referrer policy and Permissions-Policy on every path, the embedded app included', () => {
    for (const p of ['/', '/store', '/store/billing', '/api/store/legal', '/shopify', '/shopify/agents']) {
      const hsts = get(p, 'Strict-Transport-Security') ?? ''
      expect(Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0), p).toBeGreaterThanOrEqual(31536000)
      expect(hsts).toContain('includeSubDomains')
      expect(get(p, 'X-Content-Type-Options')).toBe('nosniff')
      expect(get(p, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      const pp = get(p, 'Permissions-Policy') ?? ''
      for (const f of ['camera=()', 'geolocation=()', 'payment=()']) expect(pp, p).toContain(f)
    }
  })

  it('X-Frame-Options DENY everywhere except the embedded Shopify app', () => {
    for (const p of ['/', '/store', '/store/legal', '/login', '/api/billing', '/shopifyish']) expect(get(p, 'X-Frame-Options'), p).toBe('DENY')
    for (const p of ['/shopify', '/shopify/issues']) expect(get(p, 'X-Frame-Options'), p).toBeUndefined()
  })

  it('frame-ancestors: none outside the embed; only admin.shopify.com and a valid requesting shop inside it', () => {
    expect(frameAncestors('/store/billing', null)).toBe("frame-ancestors 'none';")
    expect(frameAncestors('/shopify', 'good-shop.myshopify.com')).toBe('frame-ancestors https://good-shop.myshopify.com https://admin.shopify.com;')
    for (const shop of ['evil.com', 'x.myshopify.com.evil.com', '*.myshopify.com', 'a b.myshopify.com']) expect(frameAncestors('/shopify', shop)).toBe('frame-ancestors https://admin.shopify.com;')
  })

  it('the middleware sets the Content-Security-Policy on every page response it returns', () => {
    const src = readFileSync('middleware.ts', 'utf8')
    const body = src.slice(src.indexOf('async function embeddedHeaders'))
    // every response leaves through p.apply(...) (policy + nonce) or is the re-ordered embedded document,
    // which keeps the inner pass's policy and falls back to frame-ancestors
    const returns = body.match(/return [^\n]+/g) ?? []
    expect(returns.length).toBeGreaterThanOrEqual(4)
    for (const r of returns) expect(r, r).toMatch(/^return (p\.apply\(|new NextResponse\(appBridgeFirst|embeddedHeaders\(req\))/)
    expect(body).toMatch(/if \(!headers\.has\('Content-Security-Policy'\)\) headers\.set\('Content-Security-Policy', frameAncestors\(/)
  })
})

describe('script Content-Security-Policy (F-06)', async () => {
  const { NextRequest } = await import('next/server')
  const { middleware } = await import('../../middleware')
  const { scriptPolicy, cspHeaders, cspMode } = await import('../../lib/security/csp')
  const { appBridgeFirst } = await import('../../lib/shopify/head')

  /** a non-document request, so the embedded branch does not fetch its own second pass */
  const page = async (path: string) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { accept: '*/*' } }))
    const csp = res.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1] ?? ''
    return { res, csp, nonce }
  }

  it('/login, /store and /shopify get a nonce script policy with strict-dynamic, object-src none, base-uri self and their frame-ancestors', async () => {
    const seen = new Set<string>()
    for (const path of ['/login', '/store', '/store/agents', '/shopify', '/shopify/agents?shop=good-shop.myshopify.com']) {
      const { res, csp, nonce } = await page(path)
      expect(nonce.length, path).toBeGreaterThanOrEqual(22)
      seen.add(nonce)
      expect(csp, path).toMatch(new RegExp(`script-src 'self' 'nonce-${nonce.replace(/[+/=]/g, c => `\\${c}`)}' 'strict-dynamic'`))
      expect(csp, path).toContain("object-src 'none'")
      expect(csp, path).toContain("base-uri 'self'")
      expect(csp, path).toMatch(/connect-src 'self'/)
      expect(csp, path).not.toMatch(/'unsafe-inline'/)
      // the page renderer receives the same nonce: Next.js reads the request CSP, the root layout x-nonce
      expect(res.headers.get('x-middleware-request-x-nonce'), path).toBe(nonce)
      expect(res.headers.get('x-middleware-request-content-security-policy'), path).toBe(csp)
      const embedded = path.startsWith('/shopify')
      expect(csp.includes('https://cdn.shopify.com'), path).toBe(embedded)
      expect(csp, path).toContain(embedded ? (path.includes('good-shop') ? 'frame-ancestors https://good-shop.myshopify.com https://admin.shopify.com;' : 'frame-ancestors https://admin.shopify.com;') : "frame-ancestors 'none';")
      if (embedded) expect(res.headers.get('x-middleware-request-x-deploi-embedded')).toBe('1')
    }
    expect(seen.size).toBe(5) // a fresh nonce per response
  })

  it('a client cannot smuggle its own policy or nonce into the renderer', async () => {
    const res = await middleware(new NextRequest('http://localhost:3000/store', { headers: { accept: '*/*', 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'" } }))
    expect(res.headers.get('x-middleware-request-x-nonce')).not.toBe('attacker')
    expect(res.headers.get('x-middleware-request-content-security-policy')).not.toContain('attacker')
  })

  it('production has no unsafe-eval; dev adds it (React dev tooling) and the HMR websocket; Supabase auth is reachable', () => {
    const prod = scriptPolicy({ nonce: 'n', embedded: false, dev: false, supabaseUrl: 'https://abc.supabase.co/' })
    expect(prod).not.toContain('unsafe-eval')
    expect(prod).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co;")
    const dev = scriptPolicy({ nonce: 'n', embedded: false, dev: true })
    expect(dev).toContain("'unsafe-eval'")
    expect(dev).toMatch(/connect-src 'self' ws:/)
  })

  it('report-only mode moves only the script policy to the report-only header; frame-ancestors stays enforced', () => {
    expect(cspMode({ CSP_MODE: 'report-only' })).toBe('report-only')
    expect(cspMode({})).toBe('enforce')
    const h = Object.fromEntries(cspHeaders({ nonce: 'n', embedded: false, frameAncestors: "frame-ancestors 'none';", mode: 'report-only' }))
    expect(h['Content-Security-Policy']).toBe("frame-ancestors 'none';")
    expect(h['Content-Security-Policy-Report-Only']).toMatch(/^script-src /)
    expect(h['Content-Security-Policy-Report-Only']).not.toContain('frame-ancestors')
  })

  it('App Bridge keeps its nonce when it is moved to the top of <head>', () => {
    const html = '<html><head><meta charSet="utf-8"/><script src="/_next/a.js" async="" nonce="abc+/="></script><meta name="shopify-api-key" content="k"/><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" nonce="abc+/="></script></head><body></body></html>'
    expect(appBridgeFirst(html)).toBe('<html><head><meta charSet="utf-8"/><meta name="shopify-api-key" content="k"/><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" nonce="abc+/="></script><script src="/_next/a.js" async="" nonce="abc+/="></script></head><body></body></html>')
  })
})
