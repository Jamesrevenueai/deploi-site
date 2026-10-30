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
