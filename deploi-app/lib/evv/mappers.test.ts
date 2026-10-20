import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectMapping, SANDATA_PRESET, parseDateTime, parseFlag, parseStatus, normalizeRow, missingRequired } from './mappers'
import { parseCsv } from './ingest'

describe('vendor column mapping', () => {
  it('maps the Sandata export via the preset', () => {
    const { headers } = parseCsv(readFileSync('tests/fixtures/sandata-sample.csv', 'utf8'))
    const m = detectMapping(headers, SANDATA_PRESET)
    expect(m.vendor_visit_key).toBe('VisitKey')
    expect(m.actual_start).toBe('CallInTime')
    expect(m.gps_out_flag).toBe('CallOutGPS')
    expect(missingRequired(m)).toEqual([])
  })
  it('auto-detects a generic export from header synonyms', () => {
    const { headers } = parseCsv(readFileSync('tests/fixtures/generic-evv-sample.csv', 'utf8'))
    const m = detectMapping(headers)
    expect(m).toMatchObject({ vendor_visit_key: 'Visit ID', client_name: 'Patient', employee_name: 'Caregiver', service_code: 'Procedure Code', scheduled_start: 'Planned Start', actual_start: 'Clock In', actual_end: 'Clock Out', verification_status: 'EVV Status', gps_in_flag: 'GPS In', gps_out_flag: 'GPS Out' })
  })
  it('parses vendor dates as agency wall-clock time', () => {
    expect(parseDateTime('2026-10-15 08:00')?.toISOString()).toBe('2026-10-15T12:00:00.000Z')
    expect(parseDateTime('10/15/2026 1:30 PM')?.toISOString()).toBe('2026-10-15T17:30:00.000Z')
    expect(parseDateTime('2026-10-15T08:00:00-04:00')?.toISOString()).toBe('2026-10-15T12:00:00.000Z')
    expect(parseDateTime('')).toBeNull()
    expect(parseDateTime('nope')).toBeNull()
  })
  it('parses flags and statuses', () => {
    expect(parseFlag('Y')).toBe(true); expect(parseFlag('false')).toBe(false); expect(parseFlag('')).toBeNull()
    expect(parseStatus('Verified')).toBe('verified'); expect(parseStatus('Complete')).toBe('verified')
    expect(parseStatus('Exception')).toBe('exception'); expect(parseStatus('Incomplete')).toBe('exception'); expect(parseStatus('')).toBe('unverified')
  })
  it('normalizes a row and derives units when missing', () => {
    const row = { 'Visit ID': 'X1', Patient: 'A B', Caregiver: 'C D', 'Procedure Code': 't1019', 'Planned Start': '2026-10-15 08:00', 'Planned End': '2026-10-15 10:00', 'Clock In': '2026-10-15 08:00', 'Clock Out': '2026-10-15 09:00', 'EVV Status': 'Complete', 'GPS In': 'Y', 'GPS Out': 'Y' }
    const n = normalizeRow(row, detectMapping(Object.keys(row)), 'America/New_York')!
    expect(n.service_code).toBe('T1019')
    expect(n.units).toBe(4)
    expect(normalizeRow({ ...row, 'Visit ID': '' }, detectMapping(Object.keys(row)), 'America/New_York')).toBeNull()
  })
})
