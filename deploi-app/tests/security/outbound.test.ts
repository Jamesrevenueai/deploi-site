import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assertApprovedHost, isPrivateHost, OutboundBlocked } from '../../lib/net/outbound'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
}

describe('outbound request boundary', () => {
  it('private and loopback hosts are recognized', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('172.20.1.1')).toBe(true)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })
  it('each provider purpose only reaches its approved hosts', () => {
    expect(assertApprovedHost('https://api.resend.com/emails', 'email')).toBe('api.resend.com')
    expect(() => assertApprovedHost('https://api.resend.com', 'shopify')).toThrow(OutboundBlocked)
    expect(() => assertApprovedHost('https://evil.example', 'email')).toThrow(OutboundBlocked)
    expect(assertApprovedHost('https://shop-one.myshopify.com/admin/api', 'shopify')).toBe('shop-one.myshopify.com')
  })
  it('every outbound fetch in lib/ is guarded by assertApprovedHost', () => {
    const files = [...walk(join(process.cwd(), 'lib'))].filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !f.includes('/net/'))
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const calls = src.match(/\bfetch\(/g)?.length ?? 0
      if (calls === 0) continue
      if (!/assertApprovedHost\(/.test(src)) offenders.push(f.replace(process.cwd() + '/', ''))
    }
    expect(offenders).toEqual([])
  })
})
