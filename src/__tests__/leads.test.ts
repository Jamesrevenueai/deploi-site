import { describe, expect, it, vi } from 'vitest'
import { cleanPages, isHttpUrl, resolveLeadTarget, submitLead, validateLead, type LeadPayload } from '../lib/leads'

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
  it('requires name, valid email and agency', () => {
    expect(validateLead({ name: '', email: 'a@b.co', agency_name: 'X', source: 'site' })).toMatch(/name/)
    expect(validateLead({ name: 'A', email: 'nope', agency_name: 'X', source: 'site' })).toMatch(/email/)
    expect(validateLead({ name: 'A', email: 'a@b.co', agency_name: '', source: 'site' })).toMatch(/agency/)
    expect(validateLead({ name: 'A', email: 'a@b.co', agency_name: 'X', source: 'site' })).toBeNull()
  })

  const website: LeadPayload = {
    name: 'A', email: 'a@b.co', agency_name: 'X', source: 'site',
    service_interest: 'website_improvement',
    website_url: 'https://example-agency.test/',
    website_platform: 'Squarespace',
    website_goal: 'More families calling',
    website_pages: ['Home', 'Contact'],
    website_changes: 'Clearer services page',
    access_status: 'have_login',
  }
  it('accepts a complete website-improvement payload', () => {
    expect(validateLead(website)).toBeNull()
  })
  it('requires an http(s) website URL for a website inquiry', () => {
    expect(validateLead({ ...website, website_url: '' })).toMatch(/website address/)
    expect(validateLead({ ...website, website_url: 'example-agency.test' })).toMatch(/http/)
    expect(validateLead({ ...website, website_url: 'ftp://example-agency.test' })).toMatch(/http/)
    expect(validateLead({ ...website, website_url: 'javascript:alert(1)' })).toMatch(/http/)
    expect(validateLead({ ...website, website_url: 'http://example-agency.test/services' })).toBeNull()
  })
  it('requires platform, goal, changes and access status', () => {
    expect(validateLead({ ...website, website_platform: undefined })).toMatch(/platform/)
    expect(validateLead({ ...website, website_platform: 'Shopify' as never })).toMatch(/platform/)
    expect(validateLead({ ...website, website_goal: ' ' })).toMatch(/goal/)
    expect(validateLead({ ...website, website_changes: '' })).toMatch(/changes/)
    expect(validateLead({ ...website, access_status: undefined })).toMatch(/access/)
    expect(validateLead({ ...website, access_status: 'password' as never })).toMatch(/access/)
  })
  it('caps the page list at three', () => {
    expect(validateLead({ ...website, website_pages: ['a', 'b', 'c', 'd'] })).toMatch(/at most 3/)
    expect(validateLead({ ...website, website_pages: ['a', 'b', 'c'] })).toBeNull()
  })
  it('does not require website fields for an ordinary lead', () => {
    expect(validateLead({ name: 'A', email: 'a@b.co', agency_name: 'X', source: 'chat' })).toBeNull()
  })
})

describe('isHttpUrl and cleanPages', () => {
  it('accepts only absolute http(s) URLs with a host', () => {
    expect(isHttpUrl('https://x.test')).toBe(true)
    expect(isHttpUrl('http://x.test/path?q=1')).toBe(true)
    expect(isHttpUrl('x.test')).toBe(false)
    expect(isHttpUrl('mailto:a@b.co')).toBe(false)
    expect(isHttpUrl('https://localhost')).toBe(false)
  })
  it('drops empty strings, trims, and keeps at most three pages', () => {
    expect(cleanPages(['', ' Home ', undefined, 'Services', 'Contact', 'About'])).toEqual(['Home', 'Services', 'Contact'])
    expect(cleanPages(['', '', ''])).toEqual([])
  })
})

describe('submitLead', () => {
  const payload = { name: 'A', email: 'a@b.co', agency_name: 'X', source: 'chat' as const }
  it('posts JSON to the app API and returns the id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'lead_1' }), { status: 200 }))
    const res = await submitLead(payload, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'app', url: 'https://x/api/public/lead' } })
    expect(res).toEqual({ ok: true, id: 'lead_1' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x/api/public/lead')
    expect(JSON.parse(String(init.body))).toMatchObject({ source: 'chat', email: 'a@b.co' })
  })
  it('posts the website-improvement fields as-is, with no password field', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'lead_2' }), { status: 200 }))
    const website: LeadPayload = {
      ...payload, source: 'site', service_interest: 'website_improvement', website_url: 'https://x.test',
      website_platform: 'Wix', website_goal: 'g', website_pages: ['Home'], website_changes: 'c',
      website_issues: 'i', access_status: 'agency_managed', approval_contact: 'Pat <pat@x.test>',
    }
    await submitLead(website, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'app', url: 'https://x/api/public/lead' } })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({
      source: 'site', service_interest: 'website_improvement', website_url: 'https://x.test', website_platform: 'Wix',
      website_pages: ['Home'], access_status: 'agency_managed', approval_contact: 'Pat <pat@x.test>',
    })
    expect(Object.keys(body).some(k => /password/i.test(k))).toBe(false)
  })
  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(submitLead(payload, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'formspree', url: 'https://f' } })).rejects.toThrow(/nope/)
  })
  it('throws a configuration error when no target exists', async () => {
    await expect(submitLead(payload, { target: { kind: 'none' } })).rejects.toThrow(/not configured/)
  })
})
