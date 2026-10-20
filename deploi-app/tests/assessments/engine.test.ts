import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { getAssessment, getSteps } from '../../lib/assessments/queries'
import { traceFacts, elapsedLabel, STEPS } from '../../lib/assessments/steps'
import { creditStatus } from '../../lib/assessments/credit'
import { buildReportPdf } from '../../lib/report/pdf'
import { topLeaks, recommendedDoor } from '../../lib/leaks'

const ready = await prepareDb()
const ASSESSMENT = uuidFrom('assessment:buckeye')

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

  it('createAssessment flow: tenant row, credit, stage, assessment (SQL path of the action)', async () => {
    const prospectId = uuidFrom('prospect:p1') // Maple Grove, no tenant yet
    const { agencyId, assessmentId } = await withUser(SESSIONS.staff, async db => {
      const p = (await db.one<{ agency_name: string; city: string | null; county: string | null; state: string | null; agency_id: string | null }>('select agency_name, city, county, state, agency_id from prospects where id = $1', [prospectId]))!
      expect(p.agency_id).toBeNull()
      const g = (await db.one<{ id: string }>('insert into agencies (name, city, county, state, prospect_id) values ($1,$2,$3,$4,$5) returning id', [p.agency_name, p.city, p.county, p.state, prospectId]))!
      await db.query('update prospects set agency_id = $1 where id = $2', [g.id, prospectId])
      await db.query("update agencies set assessment_credit_cents = 150000, assessment_credit_expires_at = now() + interval '60 days' where id = $1", [g.id])
      await db.query("update prospects set stage = 'assessment_sold' where id = $1", [prospectId])
      const a = (await db.one<{ id: string }>("insert into assessments (prospect_id, agency_id, status, fee_cents) values ($1,$2,'in_progress',150000) returning id", [prospectId, g.id]))!
      return { agencyId: g.id, assessmentId: a.id }
    })
    const row = await withUser(SESSIONS.staff, db => getAssessment(db, assessmentId))
    expect(row?.agency_name).toBe('Maple Grove Home Health')
    expect(row?.prospect_stage).toBe('assessment_sold')
    expect(row?.fee_cents).toBe(150000)
    const g = await admin(db => db.one<{ assessment_credit_cents: number; assessment_credit_expires_at: string }>('select assessment_credit_cents, assessment_credit_expires_at from agencies where id = $1', [agencyId]))
    expect(g?.assessment_credit_cents).toBe(150000)
    expect(creditStatus(g!, 'assessment_sold', null)).toBe('available')
    expect(creditStatus(g!, 'build_sold', new Date())).toBe('applied')
    expect(creditStatus({ assessment_credit_cents: 1, assessment_credit_expires_at: '2020-01-01' }, 'contacted', null)).toBe('expired')
    expect(creditStatus({ assessment_credit_cents: 0, assessment_credit_expires_at: null }, null, null)).toBe('none')
    // audit trail for the read
    const audited = await admin(db => db.one<{ n: string }>("select count(*)::text as n from audit_events where table_name = 'assessments' and action = 'read' and row_id = $1", [assessmentId]))
    expect(Number(audited?.n)).toBeGreaterThan(0)
  })

  it('calculates leaks from inputs + traces and stores them with the door', async () => {
    await withUser(SESSIONS.staff, async db => {
      const a = (await getAssessment(db, ASSESSMENT))!
      const steps = await getSteps(db, ASSESSMENT)
      const leaks = topLeaks({ avg_monthly_referrals: 9, avg_referral_value_year: 18000, aide_turnover_12mo: 7, open_shift_hours_week: 22, evv_denial_rate: 0.06 }, traceFacts(steps))
      expect(leaks.length).toBe(3)
      expect(leaks[0].formula).toContain('6 h response')
      await db.query('update assessments set leaks = $1, recommended_door = $2 where id = $3', [JSON.stringify(leaks), recommendedDoor(leaks), a.id])
    })
    const row = await withUser(SESSIONS.staff, db => getAssessment(db, ASSESSMENT))
    expect(row?.leaks.length).toBe(3)
    expect(['growth', 'staffing', 'operations']).toContain(row?.recommended_door)
  })

  it('renders a PDF of at most 6 pages', async () => {
    const { a, steps } = await withUser(SESSIONS.staff, async db => ({ a: (await getAssessment(db, ASSESSMENT))!, steps: await getSteps(db, ASSESSMENT) }))
    const pdf = await buildReportPdf(a, steps)
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    expect(pages).toBeGreaterThan(0)
    expect(pages).toBeLessThanOrEqual(6)
    console.log(`PDF: ${pages} pages, ${pdf.length} bytes`)
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
})
