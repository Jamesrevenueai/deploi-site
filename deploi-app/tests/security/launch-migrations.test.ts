/** The launch migration runner refuses production unless the operator names the exact project (owner approval). */
import { describe, it, expect } from 'vitest'
import { assertTargetAllowed, productionRef, LAUNCH } from '../../scripts/launch-migrations'

const POOLER = 'postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
const DIRECT = 'postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'

describe('launch migrations: production guard', () => {
  it('covers exactly migrations 28 to 32, in order', () => {
    expect(LAUNCH.map(f => f.slice(0, 14))).toEqual(['20261028000028', '20261028000029', '20261028000030', '20261028000031', '20261028000032'])
  })
  it('recognises Supabase pooler and direct hosts', () => {
    expect(productionRef(POOLER)).toBe('abcdefghijklmnopqrst')
    expect(productionRef(DIRECT)).toBe('abcdefghijklmnopqrst')
    expect(productionRef('postgres://postgres:postgres@127.0.0.1:5432/launch_copy')).toBeNull()
  })
  it('refuses production without, or with the wrong, --confirm-production', () => {
    expect(() => assertTargetAllowed(POOLER, [])).toThrow(/owner approval required/)
    expect(() => assertTargetAllowed(DIRECT, ['--confirm-production=someotherprojectref0'])).toThrow(/owner approval required/)
    expect(() => assertTargetAllowed('postgres://u:p@10.0.0.5:5432/db', [], { DEPLOI_ENV: 'production' })).toThrow(/production database/)
    expect(() => assertTargetAllowed(POOLER, ['--confirm-production=abcdefghijklmnopqrst'])).not.toThrow()
    expect(() => assertTargetAllowed('postgres://postgres:postgres@127.0.0.1:5432/launch_copy', [], {})).not.toThrow()
  })
})
