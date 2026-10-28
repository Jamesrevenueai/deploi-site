import { describe, expect, it, vi } from 'vitest'
import {
  earlyAccessPayload,
  isHttpUrl,
  leadMailBody,
  resolveLeadTarget,
  submitLead,
  validateLead,
  type LeadPayload,
} from '../lib/leads'

const valid: LeadPayload = {
  name: 'Pat Example',
  email: 'pat@example-store.test',
  agency_name: 'Example Store',
  source: 'site',
  service_interest: 'early_access',
  store_url: 'https://example-store.test',
  platforms: ['shopify'],
  website: '',
}

describe('resolveLeadTarget', () => {
  it('prefers the app API when VITE_APP_API_URL is set', () => {
    expect(resolveLeadTarget({ appApiUrl: 'https://app.getdeploi.com', formspreeEndpoint: 'https://formspree.io/f/x' }))
      .toEqual({ kind: 'app', url: 'https://app.getdeploi.com/api/public/lead' })
  })
  it('falls back to Formspree when the app URL is empty', () => {
    expect(resolveLeadTarget({ appApiUrl: '', formspreeEndpoint: 'https://formspree.io/f/x' }))
      .toEqual({ kind: 'formspree', url: 'https://formspree.io/f/x' })
  })
  it('reports none when nothing is configured', () => {
    expect(resolveLeadTarget({ appApiUrl: '', formspreeEndpoint: '' })).toEqual({ kind: 'none' })
  })
})

describe('validateLead', () => {
  it('accepts a complete early access application', () => {
    expect(validateLead(valid)).toBeNull()
    expect(validateLead({ ...valid, platforms: ['shopify', 'woocommerce', 'amazon'], catalog_size: 'over_10000', message: 'x' })).toBeNull()
  })
  it('requires name, a valid email and the store or company name', () => {
    expect(validateLead({ ...valid, name: ' ' })).toMatch(/name/)
    expect(validateLead({ ...valid, email: 'nope' })).toMatch(/email/)
    expect(validateLead({ ...valid, agency_name: '' })).toMatch(/store or company name/)
  })
  it('requires an http(s) store URL', () => {
    expect(validateLead({ ...valid, store_url: '' })).toMatch(/store URL/)
    expect(validateLead({ ...valid, store_url: 'example-store.test' })).toMatch(/http/)
    expect(validateLead({ ...valid, store_url: 'ftp://example-store.test' })).toMatch(/http/)
    expect(validateLead({ ...valid, store_url: 'javascript:alert(1)' })).toMatch(/http/)
    expect(validateLead({ ...valid, store_url: 'http://example-store.test/collections' })).toBeNull()
  })
  it('requires at least one known platform', () => {
    expect(validateLead({ ...valid, platforms: [] })).toMatch(/at least one platform/)
    expect(validateLead({ ...valid, platforms: ['ebay' as never] })).toMatch(/platform/)
  })
  it('accepts only the listed catalog sizes', () => {
    expect(validateLead({ ...valid, catalog_size: 'huge' as never })).toMatch(/product count/)
  })
})

describe('isHttpUrl', () => {
  it('accepts only absolute http(s) URLs with a host', () => {
    expect(isHttpUrl('https://x.test')).toBe(true)
    expect(isHttpUrl('http://x.test/path?q=1')).toBe(true)
    expect(isHttpUrl('x.test')).toBe(false)
    expect(isHttpUrl('mailto:a@b.co')).toBe(false)
    expect(isHttpUrl('https://localhost')).toBe(false)
  })
})

describe('earlyAccessPayload', () => {
  it('maps the form to the exact contract, in platform order, dropping empty optionals', () => {
    const fd = new FormData()
    fd.set('name', ' Pat ')
    fd.set('email', 'pat@x.test')
    fd.set('agency_name', 'X Store')
    fd.set('store_url', 'https://x.test')
    fd.append('platforms', 'amazon')
    fd.append('platforms', 'shopify')
    fd.append('platforms', 'not-a-platform')
    fd.set('catalog_size', '')
    fd.set('message', '  ')
    fd.set('website', '')
    expect(earlyAccessPayload(fd)).toEqual({
      name: 'Pat',
      email: 'pat@x.test',
      agency_name: 'X Store',
      source: 'site',
      service_interest: 'early_access',
      store_url: 'https://x.test',
      platforms: ['shopify', 'amazon'],
      catalog_size: undefined,
      message: undefined,
      website: '',
    })
  })
  it('summarises the application for the mail fallback with readable labels', () => {
    const body = leadMailBody({ ...valid, platforms: ['shopify', 'amazon'], catalog_size: '100_1000', message: 'Oversold variants' })
    expect(body).toContain('Platforms: Shopify, Amazon Seller Central')
    expect(body).toContain('Approximate number of products: 100–1,000')
    expect(body).toContain('Store URL: https://example-store.test')
    expect(body).not.toMatch(/password/i)
  })
})

describe('submitLead', () => {
  it('posts the payload as-is to the app API and returns the id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'lead_1' }), { status: 200 }))
    const res = await submitLead(valid, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'app', url: 'https://x/api/public/lead' } })
    expect(res).toEqual({ ok: true, id: 'lead_1' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x/api/public/lead')
    expect(JSON.parse(String(init.body))).toEqual(valid)
  })
  it('adds a subject for Formspree', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await submitLead(valid, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'formspree', url: 'https://f' } })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body._subject).toMatch(/early access/)
  })
  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(submitLead(valid, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'formspree', url: 'https://f' } })).rejects.toThrow(/nope/)
  })
  it('throws a configuration error when no target exists', async () => {
    await expect(submitLead(valid, { target: { kind: 'none' } })).rejects.toThrow(/not configured/)
  })
})
