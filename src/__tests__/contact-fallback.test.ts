/**
 * The contact form falls back to the visitor's mail client when the app's contact endpoint is missing (an app
 * release older than the site answers 404) or unreachable (CORS or network failure); real refusals still show.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { submitContact, ContactUnavailable } from '../lib/contact'

const P = { name: 'Pat', email: 'pat@example.com', topic: 'sales' as const, message: 'Hi', website: '', elapsed_ms: 5000 }
afterEach(() => { vi.unstubAllGlobals() })

describe('submitContact', () => {
  it('missing endpoint (404 or 405) or a failed request: ContactUnavailable', async () => {
    for (const r of [new Response('', { status: 404 }), new Response('', { status: 405 })]) {
      vi.stubGlobal('fetch', vi.fn(async () => r))
      await expect(submitContact('https://app.example/api/public/contact', P)).rejects.toBeInstanceOf(ContactUnavailable)
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(submitContact('https://app.example/api/public/contact', P)).rejects.toBeInstanceOf(ContactUnavailable)
  })

  it('a rate limit or a server error is shown, not sent by email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(submitContact('u', P)).rejects.toThrow(/Too many messages/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const e = await submitContact('u', P).catch(x => x)
    expect(e).not.toBeInstanceOf(ContactUnavailable)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(submitContact('u', P)).resolves.toBeUndefined()
  })
})
