import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { prepareDb, SESSIONS } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { ingestCsv } from '../../lib/evv/ingest'
import { detectMapping, SANDATA_PRESET } from '../../lib/evv/mappers'
import { parseCsv } from '../../lib/evv/ingest'
import { billingHold, listExceptions } from '../../lib/evv/queries'

const ready = await prepareDb()
const AG = uuidFrom('agency:evv-test')
const CL = (i: number) => uuidFrom(`evv-test:client:${i}`)
const NOW = new Date('2026-10-20T12:00:00Z')

describe.skipIf(!ready)('Sandata CSV ingest', () => {
  beforeAll(async () => {
    await admin(async db => {
      await db.query(`insert into agencies (id, name, state) values ($1, 'EVV Test Agency', 'OH') on conflict (id) do nothing`, [AG])
      // deadlines exist only through a rule set: an agency-specific Ohio rule (any program) for this test agency
      await db.query(`insert into evv_rule_sets (id, agency_id, jurisdiction, correction_window_days, unit_minutes, unit_rounding, duration_tolerance_min, source_name, verified)
                      values ($1, $2, 'OH', 60, 15, 'nearest', 15, 'test rule', false) on conflict (id) do nothing`, [uuidFrom('evv-test:rule'), AG])
      const names = [['Avery','Okafor'],['Jordan','Lindqvist'],['Riley','Baptiste'],['Morgan','Marchetti'],['Casey','Nakamura'],['Taylor','Delgado'],['Quinn','Whitaker'],['Reese','Oyelaran'],['Harper','Castellanos'],['Rowan','Petrov'],['Emerson','Haddad'],['Finley','Brennan']]
      for (let i = 0; i < names.length; i++) {
        await db.query(`insert into clients (id, agency_id, first_name, last_name, service_codes) values ($1,$2,$3,$4,'{T1019}') on conflict (id) do nothing`, [CL(i), AG, names[i][0], names[i][1]])
        await db.query(`insert into aides (id, agency_id, first_name, last_name) values ($1,$2,$3,$4) on conflict (id) do nothing`, [uuidFrom(`evv-test:aide:${i}`), AG, names[i][0], names[i][1]])
        // everyone authorized for T1019 except client 7 (Reese) who only has S5125? no: Reese billed S5125 but authorized T1019 -> mismatch
        await db.query(`insert into authorizations (id, agency_id, client_id, service_code, units_authorized, units_used, starts_on, ends_on) values ($1,$2,$3,'T1019',$4,$5,'2026-09-01','2026-12-31') on conflict (id) do nothing`,
          [uuidFrom(`evv-test:auth:${i}`), AG, CL(i), i === 8 ? 100 : 1000, i === 8 ? 90 : 100])
      }
    })
  })
  afterAll(async () => {
    await admin(async db => { await db.query('delete from agencies where id = $1', [AG]) })
  })

  it('imports the fixture, opens the expected exceptions, and is idempotent on re-import', async () => {
    const csv = readFileSync('tests/fixtures/sandata-sample.csv', 'utf8')
    const mapping = detectMapping(parseCsv(csv).headers, SANDATA_PRESET)
    const first = await withUser(SESSIONS.staff, db => ingestCsv(db, AG, csv, mapping, { source: 'sandata', state: 'OH', now: NOW }))
    console.log(`EVV ingest: ${first.imported} visits imported, ${first.updated} updated, ${first.exceptionsOpened} exceptions opened`)
    expect(first.imported).toBe(13)
    expect(first.updated).toBe(0)
    expect(first.skipped).toBe(0)

    const open = await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))
    const byKey = (k: string) => open.filter(e => e.vendor_visit_key === k).map(e => e.rule).sort()
    expect(byKey('SND-900001')).toEqual([])
    expect(byKey('SND-900002')).toEqual(['missing_clock_in'])
    expect(byKey('SND-900003')).toEqual(['missing_clock_out'])
    expect(byKey('SND-900004')).toEqual(['duration_out_of_tolerance'])
    expect(byKey('SND-900005')).toEqual(['gps_outside_geofence'])
    expect(byKey('SND-900006')).toEqual(['gps_outside_geofence'])
    expect(byKey('SND-900007')).toEqual(['missing_clock_in', 'service_auth_mismatch', 'unverified_past_window']) // July visit predates the Sept authorization
    expect(byKey('SND-900008')).toEqual(['service_auth_mismatch'])
    expect(byKey('SND-900009')).toEqual(['units_exceed_auth'])
    expect(byKey('SND-900010')).toEqual([]) // unmatched client: auth rules skipped
    expect(byKey('SND-900013')).toEqual([]) // US date format parsed
    expect(first.exceptionsOpened).toBe(open.length)
    // soonest window first
    const closes = open.map(e => new Date(e.window_closes_at!).getTime())
    expect([...closes].sort((a, b) => a - b)).toEqual(closes)
    // "Last, First" matched the client; unknown person left null
    const matched = await admin(db => db.one<{ client_id: string | null }>(`select client_id from visits where agency_id = $1 and vendor_visit_key = 'SND-900002'`, [AG]))
    expect(matched?.client_id).toBe(CL(1))
    const unmatched = await admin(db => db.one<{ client_id: string | null }>(`select client_id from visits where agency_id = $1 and vendor_visit_key = 'SND-900010'`, [AG]))
    expect(unmatched?.client_id).toBeNull()

    const second = await withUser(SESSIONS.staff, db => ingestCsv(db, AG, csv, mapping, { source: 'sandata', state: 'OH', now: NOW }))
    expect(second.imported).toBe(0)
    expect(second.updated).toBe(0) // identical evidence: nothing rewritten, no revision
    expect(second.unchanged).toBe(13)
    expect(second.revisions).toBe(0)
    expect(second.exceptionsOpened).toBe(0)
    const total = await admin(db => db.one<{ n: string }>('select count(*)::text as n from visits where agency_id = $1', [AG]))
    expect(Number(total?.n)).toBe(13)
  })

  it('closes an exception when the rule stops firing on re-import', async () => {
    const fixed = readFileSync('tests/fixtures/sandata-sample.csv', 'utf8').replace('SND-900003,Riley Baptiste,C0003,Riley Baptiste,E0003,T1019,2026-10-15 10:00,2026-10-15 13:00,2026-10-15 10:02,,Unverified,Y,,12', 'SND-900003,Riley Baptiste,C0003,Riley Baptiste,E0003,T1019,2026-10-15 10:00,2026-10-15 13:00,2026-10-15 10:02,2026-10-15 13:00,Verified,Y,Y,12')
    const mapping = detectMapping(parseCsv(fixed).headers, SANDATA_PRESET)
    const c = await withUser(SESSIONS.staff, db => ingestCsv(db, AG, fixed, mapping, { source: 'sandata', state: 'OH', now: NOW }))
    expect(c.exceptionsClosed).toBe(1)
    expect(c.updated).toBe(1)
    expect(c.revisions).toBe(1)
    const rows = await admin(db => db.query<{ status: string; correction_note: string }>(`select e.status, e.correction_note from evv_exceptions e join visits v on v.id = e.visit_id where v.vendor_visit_key = 'SND-900003' and v.agency_id = $1`, [AG]))
    expect(rows.every(r => r.status === 'corrected' && /re-import/.test(r.correction_note))).toBe(true)
  })

  it('billing hold lists every visit with an open exception', async () => {
    const hold = await withUser(SESSIONS.staff, db => billingHold(db, AG))
    const keys = hold.map(h => h.vendor_visit_key).sort()
    expect(keys).toEqual(['SND-900002', 'SND-900004', 'SND-900005', 'SND-900006', 'SND-900007', 'SND-900008', 'SND-900009'])
    expect(hold.find(h => h.vendor_visit_key === 'SND-900007')?.open_rules).toEqual(['missing_clock_in', 'service_auth_mismatch', 'unverified_past_window'])
  })

  it('generic mapper imports another vendor export', async () => {
    const csv = readFileSync('tests/fixtures/generic-evv-sample.csv', 'utf8')
    const mapping = detectMapping(parseCsv(csv).headers)
    const c = await withUser(SESSIONS.staff, db => ingestCsv(db, AG, csv, mapping, { source: 'generic', state: 'OH', now: NOW }))
    expect(c.imported).toBe(3)
    const open = await withUser(SESSIONS.staff, db => listExceptions(db, AG, 'open', NOW))
    expect(open.filter(e => e.vendor_visit_key === 'GEN-2').map(e => e.rule)).toEqual(['missing_clock_out'])
    expect(open.filter(e => e.vendor_visit_key === 'GEN-3').map(e => e.rule).sort()).toEqual(['duration_out_of_tolerance', 'gps_outside_geofence', 'service_auth_mismatch'])
  })
})
