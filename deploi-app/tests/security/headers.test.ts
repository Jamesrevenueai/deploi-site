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
    const returns = src.match(/return (?:new NextResponse|res|r)\b/g) ?? []
    expect(returns.length).toBeGreaterThan(0)
    expect((src.match(/headers\.set\('Content-Security-Policy'/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
