import './env'
import { describe, it, expect } from 'vitest'
import { referralResponseTime, followupCompletion, interviewsBooked, shiftsConfirmedFilled, exceptionResolutionTime, staffHandlingTime, failedActions, correctionsRequired, humanReviewRate, median, wasSent, type Period } from '../../lib/pilots/metrics'

const P: Period = { start: '2026-10-01', end: '2026-10-31' }
const t = (d: string) => `2026-10-${d}`

describe('pilot measures: explicit denominators and never-count rules', () => {
  it('median handles odd, even and empty inputs', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
  it('referral_response_time: median minutes over referrals received in the period; unanswered excluded from the median but in the denominator', () => {
    const m = referralResponseTime([
      { received_at: t('02T10:00:00Z'), first_response_at: t('02T10:30:00Z'), intake_started_at: null, followup_7_at: null },
      { received_at: t('03T10:00:00Z'), first_response_at: t('03T12:00:00Z'), intake_started_at: null, followup_7_at: null },
      { received_at: t('04T10:00:00Z'), first_response_at: null, intake_started_at: null, followup_7_at: null },
      { received_at: '2026-09-20T10:00:00Z', first_response_at: '2026-09-20T10:05:00Z', intake_started_at: null, followup_7_at: null }, // outside period
    ], P)
    expect(m).toMatchObject({ value: 75, numerator: 2, denominator: 3, sample_size: 2 })
    expect(m.missing_data_note).toMatch(/1 referral\(s\) had no first response/)
    expect(m.method).toMatch(/Denominator: referrals received/)
  })
  it('followup_completion: only referrals that reached intake at least 7 days before period end are eligible', () => {
    const m = followupCompletion([
      { received_at: t('01T00:00:00Z'), first_response_at: null, intake_started_at: t('05T00:00:00Z'), followup_7_at: t('12T00:00:00Z') },
      { received_at: t('01T00:00:00Z'), first_response_at: null, intake_started_at: t('10T00:00:00Z'), followup_7_at: null },
      { received_at: t('01T00:00:00Z'), first_response_at: null, intake_started_at: t('29T00:00:00Z'), followup_7_at: null }, // too recent: not eligible
    ], P)
    expect(m).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 })
  })
  it('interviews_booked: interview_at counts; a hire or an interview_booked status without interview_at never counts', () => {
    const m = interviewsBooked([
      { applied_at: t('02T00:00:00Z'), interview_at: t('05T00:00:00Z'), status: 'interview_booked' },
      { applied_at: t('03T00:00:00Z'), interview_at: null, status: 'hired' },
      { applied_at: t('04T00:00:00Z'), interview_at: null, status: 'interview_booked' },
      { applied_at: t('05T00:00:00Z'), interview_at: null, status: 'new' },
    ], P)
    expect(m).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 })
    expect(m.method).toMatch(/Bookings are not hires/)
  })
  it('shifts_confirmed_filled: only status = filled counts; sent offers and YES replies on an open shift never count', () => {
    const m = shiftsConfirmedFilled([
      { status: 'filled', open_since: t('02T00:00:00Z'), starts_at: t('03T00:00:00Z'), filled_at: t('02T01:00:00Z') },
      { status: 'open', open_since: t('03T00:00:00Z'), starts_at: t('04T00:00:00Z'), filled_at: null, offers: [{ status: 'accepted', response: 'yes' }] },
      { status: 'open', open_since: t('04T00:00:00Z'), starts_at: t('05T00:00:00Z'), filled_at: null, offers: [{ status: 'sent', response: null }] },
      { status: 'scheduled', open_since: null, starts_at: t('06T00:00:00Z'), filled_at: null }, // never open: not in denominator
    ], P)
    expect(m).toMatchObject({ value: 0.33, numerator: 1, denominator: 3 })
    expect(m.method).toMatch(/Outreach alone is not a fill/)
  })
  it('exception_resolution_time: corrected_at only; detected-but-open exceptions and paid claims are never resolution', () => {
    const m = exceptionResolutionTime([
      { status: 'corrected', opened_at: t('01T00:00:00Z'), corrected_at: t('03T00:00:00Z') },
      { status: 'corrected', opened_at: t('01T00:00:00Z'), corrected_at: t('07T00:00:00Z') },
      { status: 'open', opened_at: t('02T00:00:00Z'), corrected_at: null, claim_status: 'paid' },
      { status: 'dismissed', opened_at: t('02T00:00:00Z'), corrected_at: null },
    ], P)
    expect(m).toMatchObject({ value: 4, numerator: 2, denominator: 2, sample_size: 2 })
    const none = exceptionResolutionTime([{ status: 'open', opened_at: t('02T00:00:00Z'), corrected_at: null, claim_status: 'paid' }], P)
    expect(none.value).toBeNull()
    expect(none.missing_data_note).toMatch(/1 detected, still open/)
  })
  it('staff_handling_time is manual entry only', () => {
    const m = staffHandlingTime()
    expect(m.value).toBeNull()
    expect(m.method).toMatch(/Manual entry/)
  })
  it('failed_actions: only attempted|delivered|failed|unknown are sends; proposed/approved/queued, sent, simulated and unknown statuses never count', () => {
    const rows = [
      { status: 'delivered', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'failed', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'attempted', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'unknown', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'failed', simulated: true, created_at: t('02T00:00:00Z') },     // simulated: never a send
      { status: 'delivered', simulated: true, created_at: t('02T00:00:00Z') },  // simulated: never a send
      { status: 'proposed', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'approved', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'queued', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'sent', simulated: false, created_at: t('02T00:00:00Z') },      // legacy status not in the set: not sent
      { status: 'skipped', simulated: false, created_at: t('02T00:00:00Z') },
      { status: 'banana', simulated: false, created_at: t('02T00:00:00Z') },
    ]
    expect(rows.filter(wasSent).length).toBe(4)
    const m = failedActions(rows, P)
    expect(m).toMatchObject({ value: 0.25, numerator: 1, denominator: 4, sample_size: 4 })
    expect(m.missing_data_note).toMatch(/2 simulated action\(s\) excluded/)
    // without the simulated column the loader passes false, and status alone decides
    expect(failedActions([{ status: 'failed', created_at: t('02T00:00:00Z') }], P)).toMatchObject({ value: 1, numerator: 1, denominator: 1 })
  })
  it('corrections_required: edited-before-approval ÷ decided; undecided proposals are not in the denominator', () => {
    const m = correctionsRequired([
      { status: 'delivered', decided_at: t('02T00:00:00Z'), decided_by: 'u', payload: { edited: true }, created_at: t('02T00:00:00Z') },
      { status: 'delivered', decided_at: t('02T00:00:00Z'), decided_by: 'u', payload: {}, created_at: t('02T00:00:00Z') },
      { status: 'skipped', decided_at: t('02T00:00:00Z'), decided_by: 'u', payload: { edited: true }, created_at: t('02T00:00:00Z') },
      { status: 'proposed', decided_at: null, decided_by: null, payload: { edited: true }, created_at: t('02T00:00:00Z') },
    ], P)
    expect(m).toMatchObject({ value: 0.67, numerator: 2, denominator: 3 })
  })
  it('human_review_rate: a decision counts as human only when decided_by is a person; auto-sends are decided but not human', () => {
    const m = humanReviewRate([
      { status: 'delivered', decided_at: t('02T00:00:00Z'), decided_by: 'person-1', created_at: t('02T00:00:00Z') },
      { status: 'skipped', decided_at: t('02T00:00:00Z'), decided_by: 'person-1', created_at: t('02T00:00:00Z') },
      { status: 'delivered', decided_at: t('02T00:00:00Z'), decided_by: null, created_at: t('02T00:00:00Z') }, // auto-send
      { status: 'proposed', decided_at: null, decided_by: null, created_at: t('02T00:00:00Z') },           // not decided
    ], P)
    expect(m).toMatchObject({ value: 0.67, numerator: 2, denominator: 3, sample_size: 3 })
  })
  it('every measure returns the full shape', () => {
    for (const m of [referralResponseTime([], P), followupCompletion([], P), interviewsBooked([], P), shiftsConfirmedFilled([], P), exceptionResolutionTime([], P), staffHandlingTime(), failedActions([], P), correctionsRequired([], P), humanReviewRate([], P)]) {
      for (const k of ['key', 'label', 'value', 'numerator', 'denominator', 'sample_size', 'method', 'missing_data_note']) expect(m, m.key).toHaveProperty(k)
      expect(m.value).toBeNull()
      expect(m.missing_data_note).toBeTruthy()
    }
  })
})
