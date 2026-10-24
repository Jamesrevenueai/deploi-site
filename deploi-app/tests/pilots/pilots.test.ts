import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, AGENCY_A, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { createEngagement } from '../../lib/engagements/queries'
import { upsertPilot, getPilot, computePeriod, listMeasurements, recordManualMeasurement, recordDecision, pilotMeasureKeys, PilotError } from '../../lib/pilots/queries'

const ready = await prepareDb()
const STAFF = SESSIONS.staff.uid
const CREATOR = uuidFrom('user:pilots-test')
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d }

describe.skipIf(!ready)('pilots', () => {
  let id = ''
  beforeAll(async () => {
    await admin(db => db.query('delete from engagements where created_by = $1', [CREATOR]))
    id = await admin(db => createEngagement(db, { agencyId: AGENCY_A, serviceKey: 'open_shift_fill', createdBy: CREATOR }))
  })
  afterAll(async () => { await admin(db => db.query('delete from engagements where created_by = $1', [CREATOR])) })

  it('the seed carries a Buckeye pilot in status pilot with baseline measurements', async () => {
    const e = await admin(db => db.one<{ status: string }>('select status from engagements where id = $1', [uuidFrom('engagement:buckeye:referral_response')]))
    expect(e?.status).toBe('pilot')
    const p = await admin(db => getPilot(db, uuidFrom('engagement:buckeye:referral_response')))
    expect(p?.primary_metric_key).toBe('referral_response_time')
    const m = await admin(db => listMeasurements(db, p!.id))
    expect(m.filter(x => x.period === 'baseline').length).toBeGreaterThanOrEqual(6)
  })
  it('primary metric must be one of the service success measures; dates must be ordered', async () => {
    const base = { engagementId: id, agencyId: AGENCY_A, serviceKey: 'open_shift_fill', startsOn: ymd(daysAgo(0)), endsOn: ymd(daysAgo(-14)), scope: null, sampleDescription: null, baselineStart: ymd(daysAgo(30)), baselineEnd: ymd(daysAgo(1)), qualityGuardrails: ['no pay-rate decisions'], dataSources: ['shifts'], reviewOwner: 'Deploi Staff' }
    await expect(admin(db => upsertPilot(db, { ...base, primaryMetricKey: 'referral_response_time' }))).rejects.toMatchObject({ code: 'invalid_metric' })
    await expect(admin(db => upsertPilot(db, { ...base, primaryMetricKey: 'shifts_confirmed_filled', endsOn: ymd(daysAgo(5)) }))).rejects.toMatchObject({ code: 'invalid_dates' })
    await admin(db => upsertPilot(db, { ...base, primaryMetricKey: 'shifts_confirmed_filled' }))
    const p = await admin(db => getPilot(db, id))
    expect(p?.primary_metric_key).toBe('shifts_confirmed_filled')
    expect(p?.quality_guardrails).toEqual(['no pay-rate decisions'])
  })
  it('reports the service measures plus the generic operating measures, marking unsupported ones', () => {
    const keys = pilotMeasureKeys('open_shift_fill')
    expect(keys.map(k => k.key)).toEqual(['shifts_confirmed_filled', 'time_to_fill', 'staff_handling_time', 'failed_actions', 'corrections_required', 'human_review_rate'])
    expect(keys.find(k => k.key === 'time_to_fill')?.supported).toBe(false)
    expect(keys.find(k => k.key === 'shifts_confirmed_filled')?.supported).toBe(true)
  })
  it('computes and stores baseline and pilot measurements from live tables with explicit denominators', async () => {
    const p = (await admin(db => getPilot(db, id)))!
    const base = await admin(db => computePeriod(db, p, 'baseline', STAFF))
    const fill = base.find(m => m.key === 'shifts_confirmed_filled')!
    // seed: 15 shifts filled in the last 7 days, 6 open now; all have open_since within the baseline window
    expect(fill.denominator).toBeGreaterThan(0)
    expect(fill.numerator).toBeLessThanOrEqual(fill.denominator!)
    const rows = await admin(db => listMeasurements(db, p.id))
    expect(rows.filter(r => r.period === 'baseline').map(r => r.metric_key).sort()).toEqual(['corrections_required', 'failed_actions', 'human_review_rate', 'shifts_confirmed_filled', 'staff_handling_time', 'time_to_fill'].sort())
    expect(rows.find(r => r.metric_key === 'time_to_fill')?.missing_data_note).toMatch(/no automated computation/)
    await admin(db => computePeriod(db, p, 'pilot', STAFF))
    const again = await admin(db => listMeasurements(db, p.id))
    expect(again.filter(r => r.period === 'pilot').length).toBe(6)
    // recomputing is idempotent (unique per pilot/metric/period)
    await admin(db => computePeriod(db, p, 'pilot', STAFF))
    expect((await admin(db => listMeasurements(db, p.id))).length).toBe(12)
  })
  it('manual entry for staff handling time survives recomputation', async () => {
    const p = (await admin(db => getPilot(db, id)))!
    await admin(db => recordManualMeasurement(db, { pilot: p, metricKey: 'staff_handling_time', period: 'pilot', value: 6.5, sampleSize: 12, note: 'timed by the scheduler over one week', actorId: STAFF }))
    await admin(db => computePeriod(db, p, 'pilot', STAFF))
    const m = (await admin(db => listMeasurements(db, p.id))).find(r => r.metric_key === 'staff_handling_time' && r.period === 'pilot')!
    expect(Number(m.value)).toBe(6.5)
    expect(m.source).toBe('manual')
  })
  it('records a decision with note and actor; refuses unknown decisions', async () => {
    const p = (await admin(db => getPilot(db, id)))!
    await expect(admin(db => recordDecision(db, { pilotId: p.id, decision: 'maybe', note: null, actorId: STAFF }))).rejects.toBeInstanceOf(PilotError)
    await admin(db => recordDecision(db, { pilotId: p.id, decision: 'expand', note: 'fill rate up', actorId: STAFF }))
    const after = (await admin(db => getPilot(db, id)))!
    expect(after.decision).toBe('expand')
    expect(after.decided_by).toBe(STAFF)
    expect(after.decision_date).toBeTruthy()
  })
  it('RLS: client B cannot read agency A pilots or measurements; client A can read its own; neither can write', async () => {
    const p = (await admin(db => getPilot(db, id)))!
    expect((await withUser(SESSIONS.clientB, db => db.query('select id from pilots where agency_id = $1', [AGENCY_A]))).length).toBe(0)
    expect((await withUser(SESSIONS.clientB, db => db.query('select id from pilot_measurements where pilot_id = $1', [p.id]))).length).toBe(0)
    expect((await withUser(SESSIONS.clientA, db => db.query('select id from pilots where id = $1', [p.id]))).length).toBe(1)
    await expect(withUser(SESSIONS.clientA, db => db.query("update pilots set decision = 'stop' where id = $1 returning id", [p.id]))).rejects.toThrow(/row-level security/)
    expect((await admin(db => getPilot(db, id)))!.decision).toBe('expand')
  })
})
