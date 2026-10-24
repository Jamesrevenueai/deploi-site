import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A, AGENCY_B } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { issueCredit, applyCredit, recordCreditPayment, creditLedgerState, CreditError, reverseApplication, listApplications, getCredit, validEligibleServiceKey, type CreditRow } from '../../lib/credit/ledger'
import { creditLabel, creditState } from '../../lib/credit/label'

const ready = await prepareDb()

describe.skipIf(!ready)('assessment credit ledger', () => {
  let creditId = ''
  beforeAll(async () => {
    await admin(db => db.query("delete from assessment_credits where agency_id in ($1, $2) and note like 'ledger-test%'", [AGENCY_A, AGENCY_B]))
    creditId = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 150000, termDays: 60, createdBy: null, note: 'ledger-test' }))
  })
  it('a mock checkout does not make the credit usable', async () => {
    await admin(db => recordCreditPayment(db, creditId, { isMock: true }))
    const c = (await admin(db => getCredit(db, creditId)))!
    expect(c.payment_status).toBe('mock_paid')
    expect(creditLedgerState(c)).toBe('unpaid')
    expect(creditState(c)).toBe('unpaid')
    expect(creditLabel(c)).toContain('simulated')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'not_paid' })
  })
  it('a real payment makes it available; it cannot be applied twice to one engagement or beyond the remainder, or to Website Improvement', async () => {
    await admin(db => recordCreditPayment(db, creditId, { isMock: false }))
    const paid = (await admin(db => getCredit(db, creditId)))!
    expect(creditState(paid)).toBe('available')
    expect(creditLabel(paid, new Date(paid.issued_at))).toBe('Credit: $1,500, expires in 60 days')
    // a later simulated call never downgrades a real payment
    await admin(db => recordCreditPayment(db, creditId, { isMock: true }))
    expect((await admin(db => getCredit(db, creditId)))!.payment_status).toBe('paid')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-web', serviceKey: 'website_improvement', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'ineligible_service' })
    const r1 = await admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 100000, actorId: null }))
    expect(r1.remainingCents).toBe(50000)
    expect(creditState((await admin(db => getCredit(db, creditId)))!)).toBe('partially_applied')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'already_applied' })
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-2', serviceKey: 'open_shift_fill', amountCents: 60000, actorId: null }))).rejects.toMatchObject({ code: 'over_remaining' })
    const r2 = await admin(db => applyCredit(db, { creditId, engagementRef: 'eng-2', serviceKey: 'open_shift_fill', amountCents: 50000, actorId: null }))
    expect(r2.remainingCents).toBe(0)
    const c = await admin(db => db.one('select * from assessment_credits where id = $1', [creditId]))
    expect(creditLedgerState(c as never)).toBe('applied')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-3', serviceKey: 'open_shift_fill', amountCents: 1, actorId: null }))).rejects.toBeInstanceOf(CreditError)
    // legacy mirror for the pipeline card
    const g = await admin(db => db.one<{ assessment_credit_applied_at: string | null }>('select assessment_credit_applied_at from agencies where id = $1', [AGENCY_A]))
    expect(g?.assessment_credit_applied_at).toBeTruthy()
  })
  it('history is preserved: a reversal keeps the row and restores the remainder', async () => {
    const app = await admin(db => db.one<{ id: string }>("select id from assessment_credit_applications where credit_id = $1 and engagement_ref = 'eng-2'", [creditId]))
    await admin(db => reverseApplication(db, app!.id, 'engagement cancelled'))
    const rows = await admin(db => listApplications(db, creditId))
    expect(rows.length).toBe(2)
    expect(rows.filter(r => r.reversed_at).length).toBe(1)
    expect(rows.find(r => r.reversed_at)?.reversal_note).toBe('engagement cancelled')
    const c = await admin(db => db.one<{ applied_cents: number }>('select applied_cents from assessment_credits where id = $1', [creditId]))
    expect(c!.applied_cents).toBe(100000)
  })
  it('expires after the term', async () => {
    const id = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 1000, termDays: 1, createdBy: null, note: 'ledger-test', now: new Date(Date.now() - 3 * 86400e3) }))
    await admin(db => recordCreditPayment(db, id, { isMock: false }))
    await expect(admin(db => applyCredit(db, { creditId: id, engagementRef: 'eng-x', serviceKey: 'referral_response', amountCents: 100, actorId: null }))).rejects.toMatchObject({ code: 'expired' })
    expect(creditLabel((await admin(db => getCredit(db, id)))!)).toBe('Credit expired: $10')
  })
  it('configurable rules: credit never above the fee, eligible service limited to a non-standalone catalog service', async () => {
    await expect(admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 150000, creditCents: 150001, termDays: 60, createdBy: null, note: 'ledger-test' }))).rejects.toMatchObject({ code: 'invalid_amount' })
    expect(validEligibleServiceKey('website_improvement')).toBeNull()
    expect(validEligibleServiceKey('bogus')).toBeNull()
    expect(validEligibleServiceKey('open_shift_fill')).toBe('open_shift_fill')
    await expect(admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 1000, termDays: 60, eligibleServiceKey: 'website_improvement', createdBy: null, note: 'ledger-test' }))).rejects.toMatchObject({ code: 'ineligible_service' })
    const limited = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 100000, creditCents: 80000, termDays: 60, eligibleServiceKey: 'open_shift_fill', createdBy: null, note: 'ledger-test-limited' }))
    await admin(db => recordCreditPayment(db, limited, { isMock: false }))
    await expect(admin(db => applyCredit(db, { creditId: limited, engagementRef: 'eng-l', serviceKey: 'referral_response', amountCents: 100, actorId: null }))).rejects.toMatchObject({ code: 'ineligible_service' })
    const r = await admin(db => applyCredit(db, { creditId: limited, engagementRef: 'eng-l', serviceKey: 'open_shift_fill', amountCents: 80000, actorId: null }))
    expect(r.remainingCents).toBe(0)
  })
  it('seed: Buckeye carries a paid synthetic credit, the control agency a simulated one that is never usable', async () => {
    const buckeye = (await admin(db => getCredit(db, uuidFrom('credit:buckeye'))))!
    const control = (await admin(db => getCredit(db, uuidFrom('credit:scioto'))))!
    expect(creditLedgerState(buckeye)).toBe('available')
    expect(control.payment_is_mock).toBe(true)
    expect(creditLedgerState(control)).toBe('unpaid')
    await expect(admin(db => applyCredit(db, { creditId: control.id, engagementRef: 'eng-seed', serviceKey: 'authorization_watch', amountCents: 100, actorId: null }))).rejects.toMatchObject({ code: 'not_paid' })
  })
  it('creditLabel/creditState accept the legacy agency columns and a ledger row alike', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    expect(creditLabel({ assessment_credit_cents: 150000, credit_expires_at: '2026-11-01T12:00:00Z' }, now)).toBe('Credit: $1,500, expires in 12 days')
    const row: CreditRow = { id: 'x', agency_id: AGENCY_A, assessment_id: null, original_fee_cents: 150000, payment_status: 'paid', payment_is_mock: false, paid_at: null, eligible_service_key: null, credit_cents: 150000, applied_cents: 50000, issued_at: now.toISOString(), expires_at: '2026-11-01T12:00:00Z', note: null }
    expect(creditLabel(row, now)).toBe('Credit: $1,000 of $1,500 remaining')
    expect(creditLabel({ ...row, payment_status: 'unpaid', payment_is_mock: true }, now)).toBe('Credit $1,500: fee not yet paid')
    expect(creditLabel({ ...row, credit_cents: 0 }, now)).toBeNull()
  })
})
