import './env'
import { describe, it, expect } from 'vitest'
import { computeReadiness, parseTwilioCampaignStatus, parseSupabasePlan, supabaseRef, TEAM_PLAN_NOTE, type ReadinessInputs } from '../../lib/setup/readiness'

const none: ReadinessInputs = {
  resendKeyPresent: false, resendTestSend: null, twilioSidPresent: false, twilioTokenPresent: false, twilioMessagingServicePresent: false,
  twilioCampaignStatus: null, stripeKeyPresent: false, baaTemplatePath: null, sowTemplatePath: null, bookingUrl: null, supabasePlan: null,
}
const all: ReadinessInputs = {
  resendKeyPresent: true, resendTestSend: { ok: true, mocked: false }, twilioSidPresent: true, twilioTokenPresent: true, twilioMessagingServicePresent: true,
  twilioCampaignStatus: 'VERIFIED', stripeKeyPresent: true, baaTemplatePath: 'templates/baa_template.pdf', sowTemplatePath: 'templates/sow_template.pdf',
  bookingUrl: 'https://cal.com/x', supabasePlan: 'team',
}

describe('computeReadiness', () => {
  it('all missing -> 7 red', () => {
    const r = computeReadiness(none)
    expect(r.total).toBe(7); expect(r.okCount).toBe(0); expect(r.incomplete).toBe(7)
    expect(r.checks.map(c => c.key)).toEqual(['resend', 'twilio', 'stripe', 'baa_template', 'sow_template', 'booking_url', 'supabase_plan'])
    expect(r.checks.find(c => c.key === 'supabase_plan')?.note).toBe(TEAM_PLAN_NOTE)
    expect(r.checks.find(c => c.key === 'supabase_plan')?.detail).toMatch(/SUPABASE_ACCESS_TOKEN/)
    expect(r.checks.find(c => c.key === 'twilio')?.detail).toMatch(/TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID/)
  })
  it('all present -> 7 green', () => {
    const r = computeReadiness(all)
    expect(r.okCount).toBe(7); expect(r.incomplete).toBe(0)
  })
  it('partial: mocked resend send, pending campaign, pro plan stay red; booking url from env counts', () => {
    const r = computeReadiness({ ...all, resendTestSend: { ok: true, mocked: true }, twilioCampaignStatus: 'IN_PROGRESS', supabasePlan: 'pro' })
    const by = Object.fromEntries(r.checks.map(c => [c.key, c]))
    expect(by.resend.ok).toBe(false); expect(by.resend.detail).toMatch(/mocked/)
    expect(by.twilio.ok).toBe(false); expect(by.twilio.detail).toMatch(/IN_PROGRESS/)
    expect(by.supabase_plan.ok).toBe(false); expect(by.supabase_plan.detail).toBe('Plan: Pro.')
    expect(by.booking_url.ok).toBe(true)
    expect(r.incomplete).toBe(3)
  })
})

describe('parsers', () => {
  it('twilio campaign status from a Usa2p list payload', () => {
    expect(parseTwilioCampaignStatus({ compliance: [{ campaign_status: 'VERIFIED', sid: 'QE1' }] })).toBe('VERIFIED')
    expect(parseTwilioCampaignStatus({ compliance: [] })).toBeNull()
    expect(parseTwilioCampaignStatus(null)).toBeNull()
  })
  it('supabase ref and plan', () => {
    expect(supabaseRef('https://abcdefghijklmnop.supabase.co')).toBe('abcdefghijklmnop')
    expect(supabaseRef('https://example.com')).toBeNull()
    expect(parseSupabasePlan({ plan: 'team' })).toBe('team')
    expect(parseSupabasePlan({ plan: { id: 'pro', name: 'Pro' } })).toBe('pro')
    expect(parseSupabasePlan({ subscription_tier: 'tier_free' })).toBe('free')
    expect(parseSupabasePlan({})).toBeNull()
  })
})
