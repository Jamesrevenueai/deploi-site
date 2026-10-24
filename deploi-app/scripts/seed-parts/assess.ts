/**
 * Assess stream seed: evidence + input statuses on the Buckeye assessment, one paid (real, synthetic) ledger credit for
 * Buckeye and one mock_paid credit for the RLS-control agency. Idempotent; deterministic ids.
 */
import type { SeedPart } from './index'
import { uuidFrom } from '../../lib/ids'
import { topLeaks, recommendedDoor, parseInputs, parseStatuses } from '../../lib/leaks'
import { traceFacts, type TraceStepRow } from '../../lib/assessments/steps'

const BUCKEYE_INPUTS = {
  avg_monthly_referrals: 9, avg_referral_value_year: 18000, aide_turnover_12mo: 7, open_shift_hours_week: 22, evv_denial_rate: 0.06,
  period_days: 90, referrals_in_period: 26, claims_in_period: 870, denied_claims_in_period: 52, open_shifts_in_period: 71, avg_shift_hours: 4,
  billed_revenue_year: 1240000, admin_hours_week: 12, admin_hourly_cost: null, recorded_expenditure_change_year: null,
}

const BUCKEYE_EVIDENCE = {
  period_start: '2026-07-01', period_end: '2026-09-28', sample_size: 870, source_reference: 'scheduler export 2026-09; billing aging report 2026-09', supplied_by: 'Office manager',
  redacted: false, staff_notes: 'Counts from the exports; referral value and turnover from the owner. Denial rate from the aging report, not the owner estimate.',
  inputs: {
    avg_monthly_referrals: { status: 'owner_reported', source: 'owner, walkthrough' },
    avg_referral_value_year: { status: 'owner_reported', source: 'owner, walkthrough' },
    aide_turnover_12mo: { status: 'owner_reported', source: 'owner, walkthrough' },
    open_shift_hours_week: { status: 'owner_reported', source: 'owner, walkthrough' },
    evv_denial_rate: { status: 'owner_reported', source: 'owner, walkthrough' },
    period_days: { status: 'measured', source: 'scheduler export 2026-09' },
    referrals_in_period: { status: 'measured', source: 'referral inbox export 2026-09' },
    claims_in_period: { status: 'measured', source: 'billing aging report 2026-09' },
    denied_claims_in_period: { status: 'measured', source: 'billing aging report 2026-09' },
    open_shifts_in_period: { status: 'measured', source: 'scheduler export 2026-09' },
    avg_shift_hours: { status: 'assumed', source: null },
    billed_revenue_year: { status: 'owner_reported', source: 'last year P&L, owner' },
    admin_hours_week: { status: 'owner_reported', source: 'office manager estimate' },
  },
  missing: ['admin_hourly_cost', 'recorded_expenditure_change_year'],
  corrections: [
    { field: 'avg_monthly_referrals', previous: '8', corrected: '9', by: 'Owner', at: '2026-10-14T15:10:00.000Z', note: 'Counted the fax referrals too', recorded_by: 'hello@getdeploi.com' },
  ],
}

export const seedArea: SeedPart = async ({ c, agencyA, agencyB, counts }) => {
  const assessmentId = uuidFrom('assessment:buckeye')
  // leaks from the seeded inputs + statuses and whatever trace steps exist (none required: an empty trace is fine)
  const steps = (await c.query('select id, trace, step_key, step_order, occurred_at, who, what_went_wrong, outcome, note from trace_steps where assessment_id = $1 order by trace, step_order', [assessmentId])).rows as TraceStepRow[]
  const statuses = parseStatuses({ statuses: Object.fromEntries(Object.entries(BUCKEYE_EVIDENCE.inputs).map(([k, v]) => [k, v.status])) })
  const leaks = topLeaks(parseInputs(BUCKEYE_INPUTS), traceFacts(steps), 3, statuses)
  await c.query('update assessments set inputs = $2, evidence = $3, leaks = $4, recommended_door = $5 where id = $1',
    [assessmentId, JSON.stringify(BUCKEYE_INPUTS), JSON.stringify(BUCKEYE_EVIDENCE), JSON.stringify(leaks), recommendedDoor(leaks)])

  const issued = new Date(Date.now() - 7 * 86400e3)
  const expires = new Date(issued.getTime() + 60 * 86400e3)
  const rows = [
    { id: uuidFrom('credit:buckeye'), agency_id: agencyA, assessment_id: uuidFrom('assessment:buckeye'), original_fee_cents: 150000, payment_status: 'paid', payment_is_mock: false, paid_at: new Date(issued.getTime() + 2 * 86400e3).toISOString(),
      eligible_service_key: null, credit_cents: 150000, applied_cents: 0, issued_at: issued.toISOString(), expires_at: expires.toISOString(), note: 'seed: synthetic paid assessment fee (no real payment happened)', payment_note: 'seed: synthetic' },
    { id: uuidFrom('credit:scioto'), agency_id: agencyB, assessment_id: null, original_fee_cents: 150000, payment_status: 'mock_paid', payment_is_mock: true, paid_at: issued.toISOString(),
      eligible_service_key: 'authorization_watch', credit_cents: 100000, applied_cents: 0, issued_at: issued.toISOString(), expires_at: expires.toISOString(), note: 'seed: mock payment, simulated, never usable', payment_note: 'seed: simulated' },
  ]
  for (const r of rows) {
    const cols = Object.keys(r)
    await c.query(
      `insert into assessment_credits (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
       on conflict (id) do update set ${cols.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(', ')}`,
      cols.map(k => (r as Record<string, unknown>)[k]))
  }
  // legacy mirror for the Buckeye card (the ledger is the truth)
  await c.query('update agencies set assessment_credit_cents = 150000, credit_expires_at = $2, assessment_credit_expires_at = $2, credit_expired = false where id = $1', [agencyA, expires.toISOString()])
  counts.assessment_credits = rows.length
}
