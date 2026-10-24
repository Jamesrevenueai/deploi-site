import './env'
import { describe, it, expect } from 'vitest'
import {
  STATUSES, TRANSITIONS, canTransition, gateFor, nextSteps, laborBudget, BUDGET_BLOCK_TEXT, BUDGET_WARN_TEXT,
  addBusinessDays, targetDate, contribution, websitePriceCents, type Engagement,
} from '../../lib/website/states'
import { stripSecrets, stripSecretsFrom, isSecretKey } from '../../lib/website/sanitize'
import { getPricing } from '../../lib/catalog/pricing'

export function fixture(over: Partial<Engagement> = {}): Engagement {
  return {
    id: '00000000-0000-5000-8000-000000000001', prospect_id: null, agency_id: null, status: 'inquiry',
    website_url: 'https://example.test', platform: 'WordPress', goal: 'more calls', pages: ['Home'], requested_changes: 'clearer CTA', known_issues: null,
    access_status: 'unknown', access_arrangement: null, approval_contact: 'Dr Example', feasibility: {},
    price_cents: 50000, payment_status: 'unpaid', payment_is_mock: true, paid_at: null,
    scope_confirmed_at: null, accepted_at: null, acceptance_evidence: null, access_received_at: null, content_received_at: null,
    preview_url: null, preview_ready_at: null, customer_approved_at: null, customer_approval_evidence: null,
    published_at: null, publication_verified_at: null, publication_verification: null, backup_plan: null, rollback_note: null, handoff_summary: null,
    before_after: [], approved_changes: [], revision_round: 0, revision_status: null, target_date: null, maintenance_requested: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  }
}

describe('transition table', () => {
  it('is the linear workflow with a revision loop and cancel; completed and cancelled are terminal', () => {
    const chain = ['inquiry', 'scope_confirmed', 'accepted', 'payment_confirmed', 'access_received', 'improving', 'preview_ready', 'customer_approved', 'published', 'completed'] as const
    for (let i = 0; i < chain.length - 1; i++) expect(canTransition(chain[i], chain[i + 1])).toBe(true)
    expect(canTransition('inquiry', 'published')).toBe(false)
    expect(canTransition('accepted', 'access_received')).toBe(false)
    expect(canTransition('preview_ready', 'improving')).toBe(true)
    expect(TRANSITIONS.completed).toEqual([])
    expect(TRANSITIONS.cancelled).toEqual([])
    expect(canTransition('published', 'cancelled')).toBe(false)
    for (const s of STATUSES) for (const t of TRANSITIONS[s]) expect(STATUSES).toContain(t)
  })
})

describe('gates', () => {
  it('accepted needs scope confirmed + acceptance evidence', () => {
    const e = fixture({ status: 'scope_confirmed' })
    expect(gateFor(e, 'accepted').ok).toBe(false)
    expect(gateFor(fixture({ status: 'scope_confirmed', scope_confirmed_at: 'x' }), 'accepted').ok).toBe(false)
    expect(gateFor(fixture({ status: 'scope_confirmed', scope_confirmed_at: 'x', acceptance_evidence: { accepted_by: 'A', method: 'email' } }), 'accepted').ok).toBe(true)
  })
  it('payment confirmed needs feasibility + a real payment; a mock payment never satisfies it', () => {
    const base = fixture({ status: 'accepted', feasibility: { status: 'feasible' } })
    expect(gateFor({ ...base, feasibility: {} , payment_status: 'paid', payment_is_mock: false }, 'payment_confirmed')).toMatchObject({ ok: false })
    const mock = gateFor({ ...base, payment_status: 'mock_paid', payment_is_mock: true, paid_at: 'x' }, 'payment_confirmed')
    expect(mock.ok).toBe(false)
    if (!mock.ok) expect(mock.reason).toMatch(/mock/i)
    expect(gateFor({ ...base, payment_status: 'paid', payment_is_mock: true }, 'payment_confirmed').ok).toBe(false)
    expect(gateFor({ ...base, payment_status: 'unpaid', payment_is_mock: false }, 'payment_confirmed').ok).toBe(false)
    expect(gateFor({ ...base, payment_status: 'paid', payment_is_mock: false }, 'payment_confirmed').ok).toBe(true)
  })
  it('access received needs have_login/agency_managed and an arrangement note', () => {
    const e = fixture({ status: 'payment_confirmed', access_status: 'need_to_find', access_arrangement: 'invited as editor' })
    expect(gateFor(e, 'access_received').ok).toBe(false)
    expect(gateFor({ ...e, access_status: 'have_login', access_arrangement: '' }, 'access_received').ok).toBe(false)
    expect(gateFor({ ...e, access_status: 'agency_managed' }, 'access_received').ok).toBe(true)
  })
  it('improving needs a backup plan; preview ready needs a preview url or a rollback note', () => {
    expect(gateFor(fixture({ status: 'access_received' }), 'improving').ok).toBe(false)
    expect(gateFor(fixture({ status: 'access_received', backup_plan: 'export + revisions' }), 'improving').ok).toBe(true)
    expect(gateFor(fixture({ status: 'improving' }), 'preview_ready').ok).toBe(false)
    expect(gateFor(fixture({ status: 'improving', rollback_note: 'no staging: direct edit with rollback note' }), 'preview_ready').ok).toBe(true)
    expect(gateFor(fixture({ status: 'improving', preview_url: 'https://staging.example.test' }), 'preview_ready').ok).toBe(true)
  })
  it('customer approved needs evidence; published needs customer_approved_at + evidence; completed needs verification + handoff', () => {
    expect(gateFor(fixture({ status: 'preview_ready' }), 'customer_approved').ok).toBe(false)
    expect(gateFor(fixture({ status: 'preview_ready', customer_approval_evidence: { method: 'email', reference: 'r', approved_by: 'A' } }), 'customer_approved').ok).toBe(true)
    const unapproved = gateFor(fixture({ status: 'customer_approved' }), 'published')
    expect(unapproved.ok).toBe(false)
    if (!unapproved.ok) expect(unapproved.reason).toMatch(/approval evidence/i)
    expect(gateFor(fixture({ status: 'customer_approved', customer_approved_at: 'x', customer_approval_evidence: { method: 'email' } }), 'published').ok).toBe(true)
    expect(gateFor(fixture({ status: 'published' }), 'completed').ok).toBe(false)
    expect(gateFor(fixture({ status: 'published', publication_verification: { checked_urls: ['https://example.test'] } }), 'completed').ok).toBe(false)
    expect(gateFor(fixture({ status: 'published', publication_verification: { checked_urls: ['https://example.test'] }, handoff_summary: 'done' }), 'completed').ok).toBe(true)
  })
  it('nextSteps lists only legal transitions with their gate', () => {
    const steps = nextSteps(fixture({ status: 'inquiry', pages: [] }))
    expect(steps.map(s => s.to)).toEqual(['scope_confirmed', 'cancelled'])
    expect(steps[0].gate.ok).toBe(false)
    expect(steps[1].gate.ok).toBe(true)
  })
})

describe('labor budget', () => {
  it('warns at 80% and blocks at 100% with the agreed wording', () => {
    expect(laborBudget(2, 5)).toMatchObject({ pct: 40, level: 'ok', message: null })
    expect(laborBudget(4, 5)).toMatchObject({ pct: 80, level: 'warn', message: BUDGET_WARN_TEXT })
    expect(laborBudget(5, 5)).toMatchObject({ pct: 100, level: 'blocked', message: BUDGET_BLOCK_TEXT })
    expect(laborBudget(6.25, 5)).toMatchObject({ pct: 125, level: 'blocked' })
    expect(BUDGET_BLOCK_TEXT).toContain('agree a smaller scope or quote additional work before proceeding')
    expect(laborBudget(0).budget).toBe(getPricing().website.hoursBudget)
  })
})

describe('target date', () => {
  it('adds business days skipping weekends', () => {
    // Fri 2026-10-23 + 5 business days = Fri 2026-10-30
    expect(addBusinessDays(new Date('2026-10-23T15:00:00Z'), 5).toISOString().slice(0, 10)).toBe('2026-10-30')
    // Sat 2026-10-24 + 1 = Mon 2026-10-26
    expect(addBusinessDays(new Date('2026-10-24T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-10-26')
    // Wed 2026-10-21 + 5 = Wed 2026-10-28
    expect(addBusinessDays(new Date('2026-10-21T00:00:00Z'), 5).toISOString().slice(0, 10)).toBe('2026-10-28')
  })
  it('is null until paid, access and content are all in; then 5 business days after the latest', () => {
    expect(targetDate({ paid_at: '2026-10-19T12:00:00Z', access_received_at: null, content_received_at: null })).toBeNull()
    expect(targetDate({ paid_at: '2026-10-19T12:00:00Z', access_received_at: '2026-10-23T12:00:00Z', content_received_at: '2026-10-20' }, 5)).toBe('2026-10-30')
    expect(targetDate({ paid_at: '2026-10-19T12:00:00Z', access_received_at: '2026-10-20T12:00:00Z', content_received_at: '2026-10-21' }, 5)).toBe('2026-10-28')
  })
})

describe('price and economics', () => {
  it('is $500 one-time from the catalog (50000 cents) and contribution = price − hours × rate', () => {
    expect(websitePriceCents()).toBe(50000)
    expect(getPricing().website.standalone).toBe(true)
    expect(getPricing().website.creditsTowardOtherServices).toBe(false)
    expect(contribution(50000, 2.5, 8500)).toEqual({ price_cents: 50000, hours: 2.5, rate_cents: 8500, cost_cents: 21250, contribution_cents: 28750 })
    expect(contribution(50000, 2.5, null).contribution_cents).toBeNull()
  })
})

describe('secret stripping', () => {
  it('replaces password-like segments and counts them; keys named like credentials are refused', () => {
    const r = stripSecrets('Login is on /wp-admin, password: hunter2 and the pwd=abc123 for ftp. Please pass the note along.')
    expect(r.removed).toBe(2)
    expect(r.text).not.toContain('hunter2')
    expect(r.text).not.toContain('abc123')
    expect(r.text).toContain('[removed]')
    expect(r.text).toContain('pass the note along')
    expect(stripSecrets('no secrets here')).toEqual({ text: 'no secrets here', removed: 0 })
    expect(stripSecretsFrom({ a: 'Password: x', b: null }).removed).toBe(1)
    expect(isSecretKey('password')).toBe(true)
    expect(isSecretKey('Login')).toBe(true)
    expect(isSecretKey('access_arrangement')).toBe(false)
  })
})
