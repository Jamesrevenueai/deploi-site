/**
 * Resend is the only outbound provider, and it is wired behind RESEND_API_KEY. With the key missing,
 * every send path answers "not configured" and makes no network call, so the app (and this suite)
 * runs without a key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { deploiMailAdapter, resendSystemEmail, fetchReceivedEmail } from '../../lib/email/adapters/deploi'
import { setEmailFetch } from '../../lib/email/adapters/http'
import type { OutgoingMessage } from '../../lib/email/types'

let calls = 0
beforeEach(() => { delete process.env.RESEND_API_KEY; calls = 0; setEmailFetch(async () => { calls++; return new Response('{}') }) })
afterEach(() => { setEmailFetch(null); delete process.env.AGENT_MAIL_DOMAIN })

describe('Resend with RESEND_API_KEY missing', () => {
  it('the agent mailbox is not configured, even with a mail domain', () => {
    process.env.AGENT_MAIL_DOMAIN = 'agents.deploi.test'
    expect(deploiMailAdapter.configured()).toBe(false)
  })

  it('an agent send is rejected as not_configured and nothing is fetched', async () => {
    const m = { deploiId: 'm1', from: 'a@agents.deploi.test', to: ['s@supplier.example'], cc: [], content: { subject: 's', bodyText: 'b', attachments: [] } } as unknown as OutgoingMessage
    const r = await deploiMailAdapter.send({} as never, '', m)
    expect(r).toMatchObject({ outcome: 'rejected', code: 'not_configured' })
    expect(calls).toBe(0)
  })

  it('a system email (weekly summary) is rejected as not_configured and nothing is fetched', async () => {
    const r = await resendSystemEmail({ from: 'Deploi <hello@getdeploi.com>', to: ['x@example.com'], subject: 's', text: 't', idempotencyKey: 'k' })
    expect(r).toMatchObject({ outcome: 'rejected', code: 'not_configured' })
    expect(calls).toBe(0)
  })

  it('reading a received email fails loudly instead of calling Resend unauthenticated', async () => {
    await expect(fetchReceivedEmail('id')).rejects.toThrow(/RESEND_API_KEY/)
    expect(calls).toBe(0)
  })

  it('with the key set, a system email goes to the Resend API with the key and the idempotency key', async () => {
    process.env.RESEND_API_KEY = 're_test_key'
    let seen: { url: string; init: RequestInit } | null = null
    setEmailFetch(async (url, init) => { seen = { url: String(url), init }; return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }) })
    const r = await resendSystemEmail({ from: 'Deploi <hello@getdeploi.com>', to: ['x@example.com'], subject: 's', text: 't', idempotencyKey: 'weekly-1' })
    expect(r).toMatchObject({ outcome: 'accepted', providerMessageId: 'e1' })
    expect(seen!.url).toBe('https://api.resend.com/emails')
    const h = seen!.init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer re_test_key')
    expect(h['idempotency-key']).toBe('weekly-1')
  })
})
