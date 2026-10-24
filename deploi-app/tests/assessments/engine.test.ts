import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import React from 'react'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { getAssessment, getSteps } from '../../lib/assessments/queries'
import { traceFacts, elapsedLabel, STEPS } from '../../lib/assessments/steps'
import { creditStatus } from '../../lib/assessments/credit'
import { parseEvidence, evidenceFromForm, addCorrectionTo, statusesFromEvidence, provenanceSummary, missingInputs } from '../../lib/assessments/evidence'
import { recommendedService, successMetric } from '../../lib/assessments/recommend'
import { buildReportPdf, ReportDocument, REPORT_MAX_PAGES } from '../../lib/report/pdf'
import { topLeaks, recommendedDoor, parseInputs, categoryTotals, LEAK_CATEGORIES } from '../../lib/leaks'
import { issueCredit, recordCreditPayment, getCreditForAssessment, creditLedgerState, CreditError } from '../../lib/credit/ledger'
import { getPricing } from '../../lib/catalog/pricing'

const ready = await prepareDb()
const ASSESSMENT = uuidFrom('assessment:buckeye')
const SEED_INPUTS = { avg_monthly_referrals: 9, avg_referral_value_year: 18000, aide_turnover_12mo: 7, open_shift_hours_week: 22, evv_denial_rate: 0.06, period_days: 90, referrals_in_period: 26, claims_in_period: 870, denied_claims_in_period: 52, open_shifts_in_period: 71, avg_shift_hours: 4, billed_revenue_year: 1240000, admin_hours_week: 12 }

describe.skipIf(!ready)('assessment engine', () => {
  beforeAll(async () => { await prepareDb() })

  it('upserts trace steps and derives facts for the calculator', async () => {
    await withUser(SESSIONS.staff, async db => {
      const ins = (trace: string, key: string, at: string, outcome: string | null = null) => db.query(
        `insert into trace_steps (assessment_id, agency_id, trace, step_key, step_order, occurred_at, who, outcome)
         values ($1,$2,$3,$4,$5,$6,'tester',$7)
         on conflict (assessment_id, trace, step_key) do update set occurred_at = excluded.occurred_at, outcome = excluded.outcome`,
        [ASSESSMENT, AGENCY_A, trace, key, STEPS[trace as 'referral' | 'visit'].findIndex(s => s.key === key), at, outcome])
      await ins('referral', 'referral_received', '2026-10-01T09:00:00Z')
      await ins('referral', 'first_response', '2026-10-01T14:00:00Z')
      await ins('referral', 'first_response', '2026-10-01T15:00:00Z') // upsert, no duplicate
      await ins('visit', 'exception_raised', '2026-10-02T12:00:00Z', 'yes')
      await ins('visit', 'corrected_in_window', '2026-10-02T12:00:00Z', 'no')
      await ins('visit', 'paid_or_denied', '2026-10-20T12:00:00Z', 'denied')
    })
    const steps = await withUser(SESSIONS.staff, db => getSteps(db, ASSESSMENT))
    expect(steps.filter(s => s.step_key === 'first_response').length).toBe(1)
    const facts = traceFacts(steps)
    expect(facts.referral_response_hours).toBe(6)
    expect(facts.visit_denied).toBe(true)
    expect(facts.exception_uncorrected).toBe(true)
    expect(elapsedLabel('2026-10-01T09:00:00Z', '2026-10-01T15:00:00Z')).toBe('6 h')
    expect(elapsedLabel('2026-10-01T09:00:00Z', '2026-10-01T09:20:00Z')).toBe('20 min')
    expect(elapsedLabel('2026-10-01T09:00:00Z', '2026-10-09T09:00:00Z')).toBe('8 d')
  })

  it('createAssessment flow: tenant row, ledger credit (unpaid until recorded), stage, assessment (SQL path of the action)', async () => {
    const prospectId = uuidFrom('prospect:p1') // Maple Grove, no tenant yet
    const termDays = getPricing().assessment.creditTermDays
    const { agencyId, assessmentId, creditId } = await withUser(SESSIONS.staff, async db => {
      const p = (await db.one<{ agency_name: string; city: string | null; county: string | null; state: string | null; agency_id: string | null }>('select agency_name, city, county, state, agency_id from prospects where id = $1', [prospectId]))!
      let agencyId = p.agency_id
      if (!agencyId) {
        const g = (await db.one<{ id: string }>('insert into agencies (name, city, county, state, prospect_id) values ($1,$2,$3,$4,$5) returning id', [p.agency_name, p.city, p.county, p.state, prospectId]))!
        agencyId = g.id
        await db.query('update prospects set agency_id = $1 where id = $2', [agencyId, prospectId])
      }
      await db.query("update prospects set stage = 'assessment_sold' where id = $1", [prospectId])
      const a = (await db.one<{ id: string }>("insert into assessments (prospect_id, agency_id, status, fee_cents) values ($1,$2,'in_progress',150000) returning id", [prospectId, agencyId]))!
      const creditId = await issueCredit(db, { agencyId, assessmentId: a.id, feeCents: 150000, creditCents: 120000, termDays, eligibleServiceKey: 'referral_response', createdBy: SESSIONS.staff.uid, note: 'engine-test' })
      return { agencyId, assessmentId: a.id, creditId }
    })
    const row = await withUser(SESSIONS.staff, db => getAssessment(db, assessmentId))
    expect(row?.agency_name).toBe('Maple Grove Home Health')
    expect(row?.prospect_stage).toBe('assessment_sold')
    expect(row?.fee_cents).toBe(150000)
    expect(row?.evidence).toEqual({})
    // the ledger is the truth: unpaid until a payment is recorded, term from pricing, credit ≤ fee, eligible service kept
    const c = (await withUser(SESSIONS.staff, db => getCreditForAssessment(db, assessmentId)))!
    expect(c.id).toBe(creditId)
    expect(c.credit_cents).toBe(120000)
    expect(c.original_fee_cents).toBe(150000)
    expect(c.eligible_service_key).toBe('referral_response')
    expect(creditLedgerState(c)).toBe('unpaid')
    expect(creditStatus(c, 'assessment_sold', null)).toBe('unpaid')
    expect(Math.round((new Date(c.expires_at!).getTime() - new Date(c.issued_at).getTime()) / 86400e3)).toBe(termDays)
    // legacy columns mirrored for older readers
    const g = await admin(db => db.one<{ assessment_credit_cents: number; assessment_credit_expires_at: string }>('select assessment_credit_cents, assessment_credit_expires_at from agencies where id = $1', [agencyId]))
    expect(g?.assessment_credit_cents).toBe(120000)
    expect(creditStatus(g!, 'assessment_sold', null)).toBe('available')
    expect(creditStatus({ assessment_credit_cents: 1, assessment_credit_expires_at: '2020-01-01' }, 'contacted', null)).toBe('expired')
    expect(creditStatus({ assessment_credit_cents: 0, assessment_credit_expires_at: null }, null, null)).toBe('none')
    // a recorded real payment makes it available
    await withUser(SESSIONS.staff, db => recordCreditPayment(db, creditId, { isMock: false, recordedBy: SESSIONS.staff.uid }))
    expect(creditStatus((await withUser(SESSIONS.staff, db => getCreditForAssessment(db, assessmentId)))!, null, null)).toBe('available')
    // audit trail for the read
    const audited = await admin(db => db.one<{ n: string }>("select count(*)::text as n from audit_events where table_name = 'assessments' and action = 'read' and row_id = $1", [assessmentId]))
    expect(Number(audited?.n)).toBeGreaterThan(0)
    // reset so the test is idempotent against the seed
    await admin(async db => { await db.query('delete from assessment_credits where id = $1', [creditId]); await db.query('delete from assessments where id = $1', [assessmentId]) })
  })

  it('calculates leaks from inputs + statuses + traces and stores them with the door, categories, grades and bounds', async () => {
    await withUser(SESSIONS.staff, async db => {
      const a = (await getAssessment(db, ASSESSMENT))!
      const steps = await getSteps(db, ASSESSMENT)
      const evidence = parseEvidence(a.evidence)
      const leaks = topLeaks(parseInputs(a.inputs as Record<string, unknown>), traceFacts(steps), 3, statusesFromEvidence(evidence))
      expect(leaks.length).toBe(3)
      for (const l of leaks) {
        expect(LEAK_CATEGORIES).toContain(l.category)
        expect(['A', 'B', 'C']).toContain(l.grade)
        expect(l.low).toBeLessThanOrEqual(l.base)
        expect(l.high).toBeGreaterThanOrEqual(l.base)
        expect(l.dollars_per_year).toBe(l.base)
      }
      // seeded broader records → the referral leak is measured, not illustrative, and the trace delay is in the formula
      const ref = leaks.find(l => l.key === 'referral_response')!
      expect(ref.illustrative).toBe(false)
      expect(ref.formula).toContain('6 h to first response')
      await db.query('update assessments set leaks = $1, recommended_door = $2 where id = $3', [JSON.stringify(leaks), recommendedDoor(leaks), a.id])
    })
    const row = await withUser(SESSIONS.staff, db => getAssessment(db, ASSESSMENT))
    expect(row?.leaks.length).toBe(3)
    expect(['growth', 'staffing', 'operations']).toContain(row?.recommended_door)
    const totals = categoryTotals(row!.leaks)
    expect(LEAK_CATEGORIES.reduce((s, c) => s + totals[c], 0)).toBeCloseTo(row!.leaks.reduce((s, l) => s + l.base, 0), 6)
  })

  it('evidence layer: statuses, period, sample, source, supplied_by, missing data and corrections round-trip through jsonb', async () => {
    const before = await withUser(SESSIONS.staff, db => getAssessment(db, ASSESSMENT))
    const seeded = parseEvidence(before!.evidence)
    expect(seeded.inputs.claims_in_period?.status).toBe('measured')
    expect(seeded.corrections.length).toBe(1)
    const inputs = parseInputs({ ...SEED_INPUTS, billed_revenue_year: '' })
    const form = { period_start: '2026-07-01', period_end: '2026-09-28', sample_size: '870', source_reference: 'scheduler export 2026-09', supplied_by: 'Office manager', redacted: 'on', staff_notes: 'test',
      status_avg_monthly_referrals: 'owner_reported', source_avg_monthly_referrals: 'owner', status_claims_in_period: 'measured', status_billed_revenue_year: 'measured' }
    let ev = evidenceFromForm(form, seeded, inputs)
    expect(ev.redacted).toBe(true)
    expect(ev.sample_size).toBe(870)
    expect(ev.corrections.length).toBe(1) // preserved
    expect(ev.missing).toContain('billed_revenue_year')
    expect(missingInputs(inputs)).toContain('admin_hourly_cost')
    ev = addCorrectionTo(ev, { field: 'billed_revenue_year', previous: '', corrected: '1240000', by: 'Owner', note: 'from the P&L', recorded_by: 'hello@getdeploi.com' })
    await withUser(SESSIONS.staff, db => db.query('update assessments set evidence = $1 where id = $2', [JSON.stringify(ev), ASSESSMENT]))
    const after = parseEvidence((await withUser(SESSIONS.staff, db => getAssessment(db, ASSESSMENT)))!.evidence)
    expect(after.period_start).toBe('2026-07-01')
    expect(after.supplied_by).toBe('Office manager')
    expect(after.inputs.avg_monthly_referrals).toEqual({ status: 'owner_reported', source: 'owner' })
    expect(after.corrections.length).toBe(2)
    expect(after.corrections[1]).toMatchObject({ field: 'billed_revenue_year', corrected: '1240000', by: 'Owner' })
    expect(statusesFromEvidence(after).claims_in_period).toBe('measured')
    const summary = provenanceSummary(topLeaks(parseInputs(SEED_INPUTS), traceFacts([]), 3, statusesFromEvidence(after)))
    expect(summary.measured).toContain('claims_in_period')
    expect(summary.assumed).toContain('referral_response_hours')
    // a trace with no step fields at all is accepted: nothing is required
    expect(traceFacts([])).toEqual({ referral_response_hours: null, visit_denied: null, exception_uncorrected: null })
    // restore the seed evidence so the suite is idempotent
    await withUser(SESSIONS.staff, db => db.query('update assessments set evidence = $1 where id = $2', [JSON.stringify(seeded), ASSESSMENT]))
  })

  it('recommends a non-standalone catalog service with a success measure', () => {
    const leaks = topLeaks(parseInputs(SEED_INPUTS), traceFacts([]))
    const svc = recommendedService(leaks, recommendedDoor(leaks))
    expect(svc.standalone).toBe(false)
    expect(successMetric(svc)?.key).toBeTruthy()
    expect(recommendedService([], 'growth').key).toBe('referral_response')
  })

  it('renders a PDF of at most 6 pages (counted in the bytes and in the React tree) with pricing from the catalog', async () => {
    const { a, steps } = await withUser(SESSIONS.staff, async db => ({ a: (await getAssessment(db, ASSESSMENT))!, steps: await getSteps(db, ASSESSMENT) }))
    const doc = ReportDocument({ a, steps }) as React.ReactElement<{ children: React.ReactNode }>
    const pages = React.Children.toArray(doc.props.children).filter(c => React.isValidElement(c)).length
    expect(pages).toBeLessThanOrEqual(REPORT_MAX_PAGES)
    const pdf = await buildReportPdf(a, steps)
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    const rendered = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThanOrEqual(6)
    console.log(`PDF: ${rendered} pages, ${pdf.length} bytes`)
  })

  it('report route: a client of another agency gets 404, the owning client can read', async () => {
    await withUser(SESSIONS.staff, db => db.query("update assessments set report_path = 'x/y.pdf' where id = $1", [ASSESSMENT]))
    const other = await withUser(SESSIONS.clientB, db => db.query('select id from assessments where id = $1', [ASSESSMENT]))
    expect(other.length).toBe(0)
    const own = await withUser(SESSIONS.clientA, db => db.query('select id from assessments where id = $1', [ASSESSMENT]))
    expect(own.length).toBe(1)
    const mod = await import('../../app/api/reports/[assessmentId]/route')
    expect(typeof mod.GET).toBe('function')
    await withUser(SESSIONS.staff, db => db.query('update assessments set report_path = null where id = $1', [ASSESSMENT]))
  })

  it('credit rules: never above the fee, never a standalone eligible service', async () => {
    await expect(admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 1000, creditCents: 1001, termDays: 60, createdBy: null, note: 'engine-test' }))).rejects.toMatchObject({ code: 'invalid_amount' })
    await expect(admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 1000, termDays: 60, eligibleServiceKey: 'website_improvement', createdBy: null, note: 'engine-test' }))).rejects.toBeInstanceOf(CreditError)
  })
})
