import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { issueCredit, applyCredit, recordCreditPayment, creditLedgerState, CreditError, reverseApplication } from '../../lib/credit/ledger'

const ready = await prepareDb()

describe.skipIf(!ready)('assessment credit ledger', () => {
  let creditId = ''
  beforeAll(async () => {
    await admin(db => db.query("delete from assessment_credits where agency_id = $1 and note = 'ledger-test'", [AGENCY_A]))
    creditId = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 150000, termDays: 60, createdBy: null, note: 'ledger-test' }))
  })
  it('a mock checkout does not make the credit usable', async () => {
    await admin(db => recordCreditPayment(db, creditId, { isMock: true }))
    const c = await admin(db => db.one('select * from assessment_credits where id = $1', [creditId]))
    expect(creditLedgerState(c as never)).toBe('unpaid')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'not_paid' })
  })
  it('a real payment makes it available; it cannot be applied twice to one engagement or beyond the remainder, or to Website Improvement', async () => {
    await admin(db => recordCreditPayment(db, creditId, { isMock: false }))
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-web', serviceKey: 'website_improvement', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'ineligible_service' })
    const r1 = await admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 100000, actorId: null }))
    expect(r1.remainingCents).toBe(50000)
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-1', serviceKey: 'referral_response', amountCents: 1000, actorId: null }))).rejects.toMatchObject({ code: 'already_applied' })
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-2', serviceKey: 'open_shift_fill', amountCents: 60000, actorId: null }))).rejects.toMatchObject({ code: 'over_remaining' })
    const r2 = await admin(db => applyCredit(db, { creditId, engagementRef: 'eng-2', serviceKey: 'open_shift_fill', amountCents: 50000, actorId: null }))
    expect(r2.remainingCents).toBe(0)
    const c = await admin(db => db.one('select * from assessment_credits where id = $1', [creditId]))
    expect(creditLedgerState(c as never)).toBe('applied')
    await expect(admin(db => applyCredit(db, { creditId, engagementRef: 'eng-3', serviceKey: 'open_shift_fill', amountCents: 1, actorId: null }))).rejects.toBeInstanceOf(CreditError)
  })
  it('history is preserved: a reversal keeps the row and restores the remainder', async () => {
    const app = await admin(db => db.one<{ id: string }>("select id from assessment_credit_applications where credit_id = $1 and engagement_ref = 'eng-2'", [creditId]))
    await admin(db => reverseApplication(db, app!.id, 'engagement cancelled'))
    const rows = await admin(db => db.query<{ reversed_at: string | null }>('select reversed_at from assessment_credit_applications where credit_id = $1 order by applied_at', [creditId]))
    expect(rows.length).toBe(2)
    expect(rows.filter(r => r.reversed_at).length).toBe(1)
    const c = await admin(db => db.one<{ applied_cents: number }>('select applied_cents from assessment_credits where id = $1', [creditId]))
    expect(c!.applied_cents).toBe(100000)
  })
  it('expires after the term', async () => {
    const id = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 1000, termDays: 1, createdBy: null, note: 'ledger-test', now: new Date(Date.now() - 3 * 86400e3) }))
    await admin(db => recordCreditPayment(db, id, { isMock: false }))
    await expect(admin(db => applyCredit(db, { creditId: id, engagementRef: 'eng-x', serviceKey: 'referral_response', amountCents: 100, actorId: null }))).rejects.toMatchObject({ code: 'expired' })
  })
})
