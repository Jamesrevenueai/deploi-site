import { describe, it, expect } from 'vitest'
import { previewBypassFrom, withPreviewBypass } from '../../lib/client/preview-bypass'

const O = 'https://deploi-app-git-x.vercel.app'
const V = 'A'.repeat(32)

describe('preview bypass header', () => {
  it('reads the value only from the launch URL or the stored copy, and rejects junk', () => {
    expect(previewBypassFrom('?shop=s&x-vercel-protection-bypass=' + V, null)).toBe(V)
    expect(previewBypassFrom('?shop=s', V)).toBe(V)
    expect(previewBypassFrom('?shop=s', null)).toBeNull()
    expect(previewBypassFrom('?x-vercel-protection-bypass=short', null)).toBeNull()
    expect(previewBypassFrom('?x-vercel-protection-bypass=' + encodeURIComponent('<script>' + V), null)).toBeNull()
  })
  it('adds the header to same-origin requests only and keeps existing headers', () => {
    const same = withPreviewBypass('/api/shopify/session', { method: 'POST', headers: { authorization: 'Bearer t' } }, O, V)
    const h = new Headers(same?.headers)
    expect(h.get('x-vercel-protection-bypass')).toBe(V)
    expect(h.get('authorization')).toBe('Bearer t')
    expect(same?.method).toBe('POST')
    const other = { headers: { a: 'b' } }
    expect(withPreviewBypass('https://admin.shopify.com/x', other, O, V)).toBe(other)
  })
})

describe('embedded API credentials', () => {
  it('omit cookies outside Vercel preview builds', async () => {
    const { embeddedCredentials } = await import('../../lib/client/preview-bypass')
    expect(process.env.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD ?? '').not.toBe('1')
    expect(embeddedCredentials).toBe('omit')
  })
})

describe('production builds never send the bypass cookie', () => {
  const load = async (vercelEnv: string | undefined) => {
    const { vi } = await import('vitest')
    vi.resetModules()
    // a production config refuses to load with dev sign-in settings, so clear them like Production does
    const keys = ['VERCEL_ENV', 'AUTH_MODE', 'ALLOW_DEV_LOGIN'] as const
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    delete process.env.AUTH_MODE; delete process.env.ALLOW_DEV_LOGIN
    if (vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv
    try { return (await import('../../next.config')).default } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  }
  it('the build flag is set only for Vercel preview builds', async () => {
    expect((await load('production')).env?.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD).toBe('')
    expect((await load(undefined)).env?.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD).toBe('')
    expect((await load('development')).env?.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD).toBe('')
    expect((await load('preview')).env?.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD).toBe('1')
  })
  it('with the production value of the flag, embedded calls omit cookies; only the preview value sends them', async () => {
    const { vi } = await import('vitest')
    for (const [flag, want] of [['', 'omit'], ['1', 'same-origin']] as const) {
      vi.resetModules()
      const saved = process.env.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD
      process.env.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD = flag
      try { expect((await import('../../lib/client/preview-bypass')).embeddedCredentials).toBe(want) } finally {
        if (saved === undefined) delete process.env.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD; else process.env.NEXT_PUBLIC_DEPLOI_PREVIEW_BUILD = saved
      }
    }
  })
  it('the embedded API helpers use that setting and nothing else', async () => {
    const { readFileSync } = await import('node:fs')
    const frame = readFileSync('components/store/ShopifyFrame.tsx', 'utf8')
    const api = readFileSync('components/store/api.ts', 'utf8')
    expect(frame).toMatch(/credentials: embeddedCredentials/)
    expect(frame).not.toMatch(/credentials: 'same-origin'/)
    expect(api).toMatch(/credentials: tokenSource \? embeddedCredentials : 'same-origin'/)
  })
})
