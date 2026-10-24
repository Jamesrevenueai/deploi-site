import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { prepareDb, SESSIONS, AGENCY_A, AGENCY_B } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { ingestCsv, ingestVisits } from '../../lib/evv/ingest'
import { detectMapping, SANDATA_PRESET, toUnits, normalizeRow } from '../../lib/evv/mappers'
import { parseCsv } from '../../lib/evv/ingest'
import { listExceptions, billingHold, listRevisions, exceptionCounts } from '../../lib/evv/queries'
import { resolveRuleSet, windowLabel, DEADLINE_NOT_CONFIGURED } from '../../lib/evv/window'
import { correctException } from '../../lib/evv/workflow'
import { unitsExceedAuth } from '../../lib/evv/rules'
import { lastSuccessfulImport } from '../../lib/imports/provenance'

const ready = await prepareDb()
const AG = uuidFrom('agency:evv-rules-test')
const CL = uuidFrom('evv-rules-test:client:0')
const NOW = new Date('2026-10-20T12:00:00Z')
const RULE = uuidFrom('evv-rules-test:rule')

const visit = (key: string, start: string, end: string, units: number | null = null) => ({
  vendor_visit_key: key, client_name: 'Rule Tester', client_ref: null, employee_name: null, service_code: 'T1019',
  scheduled_start: new Date(start), scheduled_end: new Date(end), actual_start: new Date(start), actual_end: new Date(end),
  verification_status: 'verified' as const, gps_in_flag: true, gps_out_flag: true, units, units_derived: units == null,
})

describe.skipIf(!ready)('phase 12: EVV rule sets, revisions, freshness', () => {
  beforeAll(async () => {
    await admin(async db => {
      await db.query(`insert into agencies (id, name, state, baa_signed_at) values ($1, 'EVV Rules Test Agency', 'OH', now()) on conflict (id) do nothing`, [AG])
      await db.query(`insert into clients (id, agency_id, first_name, last_name, program, service_codes) values ($1,$2,'Rule','Tester','PASSPORT','{T1019}') on conflict (id) do nothing`, [CL, AG])
      await db.query(`insert into authorizations (id, agency_id, client_id, service_code, units_authorized, units_used, starts_on, ends_on) values ($1,$2,$3,'T1019',100,90,'2026-09-01','2026-12-31') on conflict (id) do nothing`, [uuidFrom('evv-rules-test:auth'), AG, CL])
      await db.query('delete from evv_rule_sets where agency_id = $1', [AG])
    })
  })
  afterAll(async () => { await admin(db => db.query('delete from agencies where id = $1', [AG])) })

  it('unknown rule: the deadline is null and the label is "deadline not configured", never a fabricated date', async () => {
    const r = await withUser(SESSIONS.staff, db => resolveRuleSet(db, { agencyId: AG, state: 'OH', program: 'PASSPORT', date: NOW }))
    expect(r).toBeNull()
    const c = await withUser(SESSIONS.staff, db => ingestVisits(db, AG, [{ ...visit('RT-1', '2026-10-15T12:00:00Z', '2026-10-15T14:00:00Z'), actual_start: null, verification_status: 'unverified' }], { source: 'generic', state: 'OH', now: NOW }))
    expect(c.imported).toBe(1)
    expect(c.noDeadline).toBe(1)
    const open = await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))
    const rt1 = open.filter(e => e.vendor_visit_key === 'RT-1')
    expect(rt1.map(e => e.rule)).toEqual(['missing_clock_in']) // unverified_past_window cannot fire without a window
    expect(rt1[0].window_closes_at).toBeNull()
    expect(rt1[0].days_left).toBeNull()
    expect(rt1[0].rule_source).toBe(DEADLINE_NOT_CONFIGURED)
    expect(windowLabel(rt1[0].days_left)).toBe('deadline not configured')
    const hold = await withUser(SESSIONS.staff, db => billingHold(db, AG))
    expect(hold.find(h => h.vendor_visit_key === 'RT-1')?.rule_source).toBe(DEADLINE_NOT_CONFIGURED)
    expect((await withUser(SESSIONS.staff, db => exceptionCounts(db, AG))).noDeadline).toBe(1)
    // the seeded control agency has no rule either; the demo agency has the unverified Ohio PASSPORT one
    expect(await withUser(SESSIONS.staff, db => resolveRuleSet(db, { agencyId: AGENCY_B, state: 'OH', program: 'PASSPORT', date: NOW }))).toBeNull()
    const demo = await withUser(SESSIONS.staff, db => resolveRuleSet(db, { agencyId: AGENCY_A, state: 'OH', program: 'PASSPORT', date: NOW }))
    expect(demo).toMatchObject({ correction_window_days: 60, verified: false, source_name: 'Working assumption, confirm with ODM' })
    expect(await withUser(SESSIONS.staff, db => resolveRuleSet(db, { agencyId: AGENCY_A, state: 'OH', program: 'OHCW', date: NOW }))).toBeNull()
  })

  it('unit conversion follows the configured minutes and rounding: nearest / down / up', async () => {
    expect(toUnits(61, 15, 'nearest')).toBe(4); expect(toUnits(68, 15, 'nearest')).toBe(5)
    expect(toUnits(74, 15, 'down')).toBe(4); expect(toUnits(74, 15, 'up')).toBe(5)
    expect(toUnits(60, 15, 'up')).toBe(4); expect(toUnits(60, 15, 'down')).toBe(4)
    expect(toUnits(50, 60, 'nearest')).toBe(1); expect(toUnits(50, 60, 'down')).toBe(0); expect(toUnits(50, 60, 'up')).toBe(1)
    expect(toUnits(0, 15, 'up')).toBe(0); expect(toUnits(-5, 15, 'nearest')).toBe(0)
    const row = { 'Visit ID': 'U1', Patient: 'A B', 'Procedure Code': 'T1019', 'Clock In': '2026-10-15 08:00', 'Clock Out': '2026-10-15 09:10' }
    const m = detectMapping(Object.keys(row))
    expect(normalizeRow(row, m, 'America/New_York')!.units).toBe(5)                                  // 70 min, 15-min units nearest
    expect(normalizeRow(row, m, 'America/New_York', { unitMinutes: 15, rounding: 'down' })!.units).toBe(4)
    expect(normalizeRow(row, m, 'America/New_York', { unitMinutes: 30, rounding: 'up' })!.units).toBe(3)
    // no clock-out: units are NOT derived from the schedule
    const noOut = { ...row, 'Clock Out': '', 'Planned Start': '2026-10-15 08:00', 'Planned End': '2026-10-15 10:00' }
    expect(normalizeRow(noOut, detectMapping(Object.keys(noOut)), 'America/New_York')!.units).toBeNull()
    // units_exceed_auth uses the rule's conversion: 70 min = 5 units nearest (fits 10 remaining), but 60-min units rounded up on 125 min = 3 … and 15-min up on 155 min = 11 > 10
    const ctx = { authorizations: [{ client_id: 'c', service_code: 'T1019', units_authorized: 100, units_used: 90, starts_on: new Date('2026-09-01T00:00:00Z'), ends_on: new Date('2026-12-31T00:00:00Z') }], toleranceMin: 15, windowDays: null, now: NOW }
    const v = { client_id: 'c', service_code: 'T1019', scheduled_start: new Date('2026-10-15T12:00:00Z'), scheduled_end: new Date('2026-10-15T14:35:00Z'), actual_start: new Date('2026-10-15T12:00:00Z'), actual_end: new Date('2026-10-15T14:35:00Z'), verification_status: 'verified', gps_in_flag: true, gps_out_flag: true, units: null }
    expect(unitsExceedAuth(v, { ...ctx, unitMinutes: 15, unitRounding: 'up' })?.detail).toContain('11 units')
    expect(unitsExceedAuth(v, { ...ctx, unitMinutes: 15, unitRounding: 'down' })).toBeNull()       // 10 units
    expect(unitsExceedAuth(v, { ...ctx, unitMinutes: 60, unitRounding: 'nearest' })).toBeNull()    // 3 units
  })

  it('with a rule set the ingest applies its window, tolerance and unit conversion; derived units follow the rule', async () => {
    await admin(db => db.query(`insert into evv_rule_sets (id, agency_id, program, jurisdiction, effective_from, correction_window_days, unit_minutes, unit_rounding, duration_tolerance_min, source_name, source_version, verified)
      values ($1, $2, 'PASSPORT', 'OH', '2026-01-01', 45, 30, 'up', 10, 'Test payer manual', '2026-10', true)`, [RULE, AG]))
    const c = await withUser(SESSIONS.staff, db => ingestVisits(db, AG, [visit('RT-2', '2026-10-15T12:00:00Z', '2026-10-15T14:35:00Z')], { source: 'generic', state: 'OH', now: NOW }))
    expect(c.imported).toBe(1)
    const v = await admin(db => db.one<{ units: number }>("select units from visits where agency_id = $1 and vendor_visit_key = 'RT-2'", [AG]))
    expect(v?.units).toBe(6) // 155 min / 30-min units rounded up
    const open = await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))
    const rt2 = open.filter(e => e.vendor_visit_key === 'RT-2')
    expect(rt2.length).toBe(0) // 6 units fit the 10 remaining; duration matches schedule
    // re-ingest RT-1 (unverified, no clock-in): now a 45-day window applies and the exception gets a deadline with its source
    await withUser(SESSIONS.staff, db => ingestVisits(db, AG, [{ ...visit('RT-1', '2026-10-15T12:00:00Z', '2026-10-15T14:00:00Z'), actual_start: null, verification_status: 'unverified' }], { source: 'generic', state: 'OH', now: NOW }))
    const again = (await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))).find(e => e.vendor_visit_key === 'RT-1')!
    expect(again.window_closes_at?.slice(0, 10)).toBe('2026-11-29')
    expect(again.days_left).toBe(40)
    expect(again.rule_source).toBe('Test payer manual · v2026-10 · verified')
  })

  it('a reviewed visit keeps its original evidence: re-import writes a revision (flagged reviewed) instead of a blind overwrite', async () => {
    const before = await admin(db => db.one<{ id: string; actual_start: Date | null; actual_end: Date; units: number }>("select id, actual_start, actual_end, units from visits where agency_id = $1 and vendor_visit_key = 'RT-1'", [AG]))
    const ex = (await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))).find(e => e.vendor_visit_key === 'RT-1')!
    expect(await withUser(SESSIONS.staff, db => correctException(db, ex.id, 'Clock-in added in the vendor portal'))).toBe(true)
    const c = await withUser(SESSIONS.staff, db => ingestVisits(db, AG, [visit('RT-1', '2026-10-15T12:00:00Z', '2026-10-15T14:00:00Z')], { source: 'generic', state: 'OH', now: NOW, importId: null }))
    expect(c.updated).toBe(1)
    expect(c.revisions).toBe(1)
    const revs = await withUser(SESSIONS.staff, db => listRevisions(db, AG, before!.id))
    expect(revs.length).toBe(1)
    expect(revs[0].reviewed).toBe(true)
    expect(revs[0].changed_fields).toContain('actual_start')
    expect(revs[0].previous.actual_start).toBeNull() // the original evidence (no clock-in) is preserved verbatim
    expect(revs[0].previous.vendor_visit_key).toBe('RT-1')
    const after = await admin(db => db.one<{ actual_start: Date | null }>("select actual_start from visits where id = $1", [before!.id]))
    expect(after?.actual_start).not.toBeNull()
    // the human decision survives: the corrected exception is not reopened
    const corrected = await admin(db => db.one<{ status: string; correction_note: string }>('select status, correction_note from evv_exceptions where id = $1', [ex.id]))
    expect(corrected).toMatchObject({ status: 'corrected', correction_note: 'Clock-in added in the vendor portal' })
    // identical re-import: no revision, nothing updated
    const same = await withUser(SESSIONS.staff, db => ingestVisits(db, AG, [visit('RT-1', '2026-10-15T12:00:00Z', '2026-10-15T14:00:00Z')], { source: 'generic', state: 'OH', now: NOW }))
    expect(same).toMatchObject({ updated: 0, unchanged: 1, revisions: 0 })
  })

  it('row errors carry data row numbers; in-file duplicates are reported and the first wins', async () => {
    const csv = readFileSync('tests/fixtures/sandata-sample.csv', 'utf8').split('\n').slice(0, 4).join('\n')
      + '\nSND-900001,Avery Okafor,C0001,Avery Okafor,E0001,T1019,2026-10-15 08:00,2026-10-15 10:00,2026-10-15 07:58,2026-10-15 10:03,Verified,Y,Y,9'
      + '\n,Nobody,C0,Nobody,E0,T1019,2026-10-15 08:00,2026-10-15 10:00,,,Unverified,,,8\n'
    const mapping = detectMapping(parseCsv(csv).headers, SANDATA_PRESET)
    const c = await withUser(SESSIONS.staff, db => ingestCsv(db, AG, csv, mapping, { source: 'sandata', state: 'OH', now: NOW }))
    expect(c.rows).toBe(5)
    expect(c.imported).toBe(3)
    expect(c.duplicates).toBe(1)
    expect(c.errors).toEqual([
      { row: 4, field: 'vendor_visit_key', message: expect.stringContaining('duplicate visit key SND-900001, first seen on row 1') },
      { row: 5, field: 'vendor_visit_key', message: 'visit key is required' },
    ])
    const units = await admin(db => db.one<{ units: number }>("select units from visits where agency_id = $1 and vendor_visit_key = 'SND-900001'", [AG]))
    expect(units?.units).toBe(8) // first occurrence kept
  })

  it('stale flag: no import -> stale; a fresh committed import -> fresh; an old one -> stale after the threshold', async () => {
    const none = await withUser(SESSIONS.staff, db => lastSuccessfulImport(db, 'evv_visits', AG))
    expect(none).toMatchObject({ at: null, stale: true, thresholdDays: 7 })
    await admin(db => db.query("insert into evv_imports (agency_id, source, filename, status, committed_at, created_at) values ($1,'generic','old.csv','committed', now() - interval '9 days', now() - interval '9 days')", [AG]))
    const old = await withUser(SESSIONS.staff, db => lastSuccessfulImport(db, 'evv_visits', AG))
    expect(old.stale).toBe(true); expect(old.days).toBe(9)
    await admin(db => db.query("insert into evv_imports (agency_id, source, filename, status, committed_at) values ($1,'generic','new.csv','committed', now())", [AG]))
    const fresh = await withUser(SESSIONS.staff, db => lastSuccessfulImport(db, 'evv_visits', AG))
    expect(fresh).toMatchObject({ stale: false, days: 0, filename: 'new.csv' })
    const staged = await withUser(SESSIONS.staff, db => db.query("select 1 from evv_imports where agency_id = $1 and status = 'staged'", [AG]))
    expect(staged.length).toBe(0)
  })
})
