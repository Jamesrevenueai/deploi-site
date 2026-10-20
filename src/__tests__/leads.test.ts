import { describe, expect, it, vi } from 'vitest'
import { resolveLeadTarget, submitLead, validateLead } from '../lib/leads'

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
  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(submitLead(payload, { fetchImpl: fetchImpl as unknown as typeof fetch, target: { kind: 'formspree', url: 'https://f' } })).rejects.toThrow(/nope/)
  })
  it('throws a configuration error when no target exists', async () => {
    await expect(submitLead(payload, { target: { kind: 'none' } })).rejects.toThrow(/not configured/)
  })
})
