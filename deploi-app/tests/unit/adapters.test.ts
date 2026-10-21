import { describe, it, expect } from 'vitest'
import { sendEmail, mockOutbox, FROM } from '../../lib/adapters/email'
import { sendSms, mockSmsOutbox } from '../../lib/adapters/sms'
import { complete } from '../../lib/llm'
import { phiComplete } from '../../lib/phi'

describe('adapters mock when env is empty', () => {
  it('email goes to the mock outbox from hello@getdeploi.com', async () => {
    const r = await sendEmail({ to: 'x@example.com', subject: 'hi', text: 'hello' })
    expect(r.ok && r.mocked).toBe(true)
    expect(mockOutbox.length).toBe(1)
    expect(FROM).toBe('Deploi AI <hello@getdeploi.com>')
  })
  it('sms goes to the mock outbox', async () => {
    const r = await sendSms({ to: '+16145550100', body: 'hi' })
    expect(r.ok && r.mocked).toBe(true)
    expect(mockSmsOutbox.length).toBe(1)
  })
  it('llm lanes return mock output with LLM_MOCK=1', async () => {
    const l = await complete('local', { prompt: 'x' })
    const c = await complete('cloud', { prompt: 'x', json: true })
    const p = await phiComplete({ prompt: 'x' })
    expect(l.mocked && c.mocked && p.mocked).toBe(true)
    expect(l.provider).toBe('ollama')
    expect(JSON.parse(c.text).mocked).toBe(true)
  })
})

describe('payments adapter', () => {
  it('is always simulated and a key alone never makes it live', async () => {
    const { createCheckout, paymentsMode, mockPayments } = await import('../../lib/adapters/payments')
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
    expect(paymentsMode()).toBe('mock')
    const r = await createCheckout({ amountCents: 50000, purpose: 'website_fee', ref: 'web-1' })
    expect(r.mocked).toBe(true)
    expect(r.status).toBe('simulated')
    expect(mockPayments.at(-1)?.id).toBe(r.id)
    process.env.PAYMENTS_LIVE = 'true'
    expect(paymentsMode()).toBe('live_not_implemented')
    await expect(createCheckout({ amountCents: 1, purpose: 'website_fee', ref: 'x' })).rejects.toThrow(/not implemented/i)
    delete process.env.PAYMENTS_LIVE; delete process.env.STRIPE_SECRET_KEY
  })
})
