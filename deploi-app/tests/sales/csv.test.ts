import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDb, SESSIONS } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { parseCsv, guessMapping, applyMapping, importRows, normalizePrograms } from '../../lib/sales/csv'

// tests/setup.ts forces .env.test; allow a per-section database for parallel section work
if (process.env.SALES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.SALES_TEST_DATABASE_URL
const ready = await prepareDb()
const csv = readFileSync(join(process.cwd(), 'tests/fixtures/prospects-20.csv'), 'utf8')

describe('CSV import', () => {
  it('auto-detects headers and normalizes programs', () => {
    const { headers, rows } = parseCsv(csv)
    expect(rows.length).toBe(20)
    const m = guessMapping(headers)
    expect(m.agency_name).toBe('Agency Name')
    expect(m.owner_name).toBe('Owner')
    expect(m.email).toBe('Email')
    expect(m.county).toBe('County')
    expect(m.programs).toBe('Programs')
    expect(m.owner_notes).toBe('Notes')
    expect(normalizePrograms('PASSPORT; ohcw / Private Pay, bogus')).toEqual(['PASSPORT', 'OHCW', 'private-pay'])
    const { rows: mapped, rejected } = applyMapping(rows, m)
    expect(rejected).toBe(0)
    expect(mapped[0].programs).toEqual(['PASSPORT', 'OHCW'])
    expect(mapped[0].email).toBe('alex@grandviewcompanions.example')
  })

  it.skipIf(!ready)('imports 20, skips 20 on re-import, rejects rows without agency', async () => {
    const { headers, rows } = parseCsv(csv)
    const { rows: mapped } = applyMapping(rows, guessMapping(headers))
    const first = await withUser(SESSIONS.staff, db => importRows(db, mapped))
    expect(first).toEqual({ imported: 20, skipped: 0 })
    const second = await withUser(SESSIONS.staff, db => importRows(db, mapped))
    expect(second).toEqual({ imported: 0, skipped: 20 })
    const { rejected } = applyMapping([{ 'Agency Name': '', Owner: 'x' }], guessMapping(headers))
    expect(rejected).toBe(1)
    console.log(`CSV import: ${first.imported} imported / ${first.skipped} skipped; re-import ${second.imported} imported / ${second.skipped} skipped`)
    await admin(db => db.query('delete from prospects where lower(email) = any($1)', [mapped.map(r => r.email)]))
  })
})
