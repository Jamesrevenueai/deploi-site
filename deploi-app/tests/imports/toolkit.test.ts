import './env'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { IMPORT_SPECS, IMPORT_KINDS, parseCsv, fileSha256, detectMapping, missingRequired, templateCsv, templateHeaders, validateRows, normalizePhone, parseDateOnly, runApplicantImport, findPriorImport, recordAlreadyImported, lastSuccessfulImport, staleAfterDays } from '../../lib/imports'

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ uid: 'u', email: 'hello@getdeploi.com', role: 'staff', agencyId: null })) }))

const ready = await prepareDb()
const AG = uuidFrom('agency:imports-test')
const CSV = 'first_name,last_name,phone,email\nAvery,Okafor,+16145550199,avery@example.com\nJordan,Lindqvist,(614) 555-0198,jordan@example.com\nRiley,Baptiste,,riley@example.com\n'

describe('import toolkit (pure)', () => {
  it('templates carry exactly the documented headers for every kind', () => {
    for (const kind of IMPORT_KINDS) {
      const { headers, rows } = parseCsv(templateCsv(kind))
      expect(headers).toEqual(IMPORT_SPECS[kind].fields.map(f => f.key))
      expect(headers).toEqual(templateHeaders(kind))
      expect(rows.length).toBe(1)
    }
    expect(templateHeaders('evv_visits')).toEqual(['vendor_visit_key', 'client_name', 'client_ref', 'employee_name', 'service_code', 'scheduled_start', 'scheduled_end', 'actual_start', 'actual_end', 'verification_status', 'gps_in_flag', 'gps_out_flag', 'units'])
    expect(templateHeaders('applicants')).toEqual(['first_name', 'last_name', 'phone', 'email', 'applied_at', 'source'])
  })
  it('auto-maps vendor headers and reports missing required fields', () => {
    const spec = IMPORT_SPECS.applicants
    expect(detectMapping(spec, ['First', 'Last', 'Mobile', 'E-mail'])).toEqual({ first_name: 'First', last_name: 'Last', phone: 'Mobile', email: 'E-mail' })
    expect(missingRequired(spec, { first_name: 'First' })).toEqual(['last_name'])
  })
  it('validates rows with row numbers: identifiers, dates, numbers ≥ 0, phone format; in-file duplicates by phone then name', () => {
    const rows = parseCsv('first_name,last_name,phone,email,applied_at\nA,B,614555,bad-email,2026-13-45\n,C,+16145550100,c@example.com,10/02/2026\nD,E,+16145550100,d@example.com,\nF,G,,,\nF,G,,,\n').rows
    const v = validateRows(IMPORT_SPECS.applicants, rows, detectMapping(IMPORT_SPECS.applicants, ['first_name', 'last_name', 'phone', 'email', 'applied_at']))
    expect(v.errors).toEqual([
      { row: 1, field: 'phone', message: expect.stringContaining('invalid phone') },
      { row: 1, field: 'email', message: expect.stringContaining('invalid email') },
      { row: 1, field: 'applied_at', message: expect.stringContaining('invalid date') },
      { row: 2, field: 'first_name', message: 'First name is required' },
      { row: 5, field: null, message: 'duplicate of row 4 (name)' },
    ])
    expect(v.valid.map(r => r.row)).toEqual([3, 4])
    expect(v.duplicatesInFile).toBe(1)
    const u = validateRows(IMPORT_SPECS.evv_visits, parseCsv('vendor_visit_key,service_code,units,actual_start\nK1,t1019,-3,2026-10-15 08:00\nK2,T1019,abc,nope\nK1,T1019,4,\n').rows, { vendor_visit_key: 'vendor_visit_key', service_code: 'service_code', units: 'units', actual_start: 'actual_start' })
    expect(u.errors.map(e => [e.row, e.field])).toEqual([[1, 'units'], [2, 'actual_start'], [2, 'units']])
    expect(u.valid.map(r => r.values.service_code)).toEqual(['T1019'])
    expect(normalizePhone('614-555-0100')).toBe('+16145550100'); expect(normalizePhone('12345')).toBeNull()
    expect(parseDateOnly('10/2/2026')).toBe('2026-10-02')
  })
  it('hashes content independent of line endings', () => {
    expect(fileSha256('a,b\r\n1,2\r\n')).toBe(fileSha256('a,b\n1,2'))
    expect(fileSha256('a,b\n1,2')).not.toBe(fileSha256('a,b\n1,3'))
    expect(staleAfterDays('applicants')).toBe(7)
  })
  it('the template route returns the documented headers as CSV for staff', async () => {
    const { GET } = await import('../../app/api/imports/template/[kind]/route')
    const { templateResponse } = await import('../../lib/imports/template-response')
    const res = await GET(new Request('http://localhost/api/imports/template/applicants'), { params: Promise.resolve({ kind: 'applicants' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(parseCsv(await res.text()).headers).toEqual(templateHeaders('applicants'))
    expect(templateResponse('nope').status).toBe(404)
  })
})

describe.skipIf(!ready)('applicant import on the toolkit', () => {
  beforeAll(async () => {
    await admin(async db => {
      await db.query(`insert into agencies (id, name, state, baa_signed_at) values ($1, 'Imports Test Agency', 'OH', now()) on conflict (id) do nothing`, [AG])
      await db.query('delete from applicants where agency_id = $1', [AG])
      await db.query('delete from imports where agency_id = $1', [AG])
    })
  })
  afterAll(async () => { await admin(db => db.query('delete from agencies where id = $1', [AG])) })

  it('imports once, then refuses the same file as "already imported" with a provenance row and 0 imported', async () => {
    const first = await withUser(SESSIONS.staff, db => runApplicantImport(db, { agencyId: AG, text: CSV, filename: 'apps.csv', createdBy: SESSIONS.staff.uid }))
    expect(first).toMatchObject({ status: 'committed', rowCount: 3, imported: 3, duplicates: 0, skipped: 0 })
    const phones = await admin(db => db.query<{ phone: string | null }>('select phone from applicants where agency_id = $1 order by last_name', [AG]))
    expect(phones.map(p => p.phone)).toEqual([null, '+16145550198', '+16145550199']) // normalised
    const second = await withUser(SESSIONS.staff, db => runApplicantImport(db, { agencyId: AG, text: CSV.replace(/\n/g, '\r\n'), filename: 'apps-again.csv', createdBy: SESSIONS.staff.uid }))
    expect(second).toMatchObject({ status: 'already_imported', imported: 0 })
    expect(second.notice).toMatch(/already imported/)
    const log = await admin(db => db.query<{ status: string; notice: string | null; imported: number }>("select status, notice, imported from imports where agency_id = $1 and kind = 'applicants' order by created_at", [AG]))
    expect(log.map(l => l.status)).toEqual(['committed', 'already_imported'])
    expect(log[1].notice).toMatch(/already imported/)
    expect(await admin(db => db.one<{ n: string }>('select count(*)::text as n from applicants where agency_id = $1', [AG]))).toEqual({ n: '3' })
  })

  it('a changed file imports only the new rows, reports duplicates against existing records with row numbers', async () => {
    const changed = CSV + 'Avery,Okafor,+16145550199,avery2@example.com\nRiley,Baptiste,,riley@example.com\nNew,Person,+16145550197,\n,Missing,,\n'
    const r = await withUser(SESSIONS.staff, db => runApplicantImport(db, { agencyId: AG, text: changed, filename: 'apps-v2.csv', createdBy: SESSIONS.staff.uid }))
    expect(r.status).toBe('committed')
    expect(r.imported).toBe(1)
    expect(r.errors.map(e => [e.row, e.message])).toEqual([
      [1, 'already on file (same phone), skipped'], [2, 'already on file (same phone), skipped'], [3, 'already on file (same name), skipped'],
      [4, 'duplicate of row 1 (phone)'], [5, 'duplicate of row 3 (name)'], [7, 'First name is required'],
    ])
    expect(r.duplicates).toBe(5)
    expect(r.skipped).toBe(6)
    const stored = await admin(db => db.one<{ row_errors: unknown[]; duplicates: number; file_sha256: string }>('select row_errors, duplicates, file_sha256 from imports where id = $1', [r.importId]))
    expect(stored?.row_errors.length).toBe(6)
    expect(stored?.file_sha256).toBe(fileSha256(changed))
    expect(await withUser(SESSIONS.staff, db => findPriorImport(db, 'applicants', AG, fileSha256(changed)))).toMatchObject({ id: r.importId })
    const fresh = await withUser(SESSIONS.staff, db => lastSuccessfulImport(db, 'applicants', AG))
    expect(fresh).toMatchObject({ stale: false, days: 0, filename: 'apps-v2.csv' })
    const id = await withUser(SESSIONS.staff, db => recordAlreadyImported(db, 'applicants', AG, { filename: 'x.csv', sha: 'abc', rowCount: 1, createdBy: null, priorId: r.importId }))
    expect(id).toBeTruthy()
  })
})
