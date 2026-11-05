/** The restore rehearsal script (docs/BACKUP-RESTORE.md) passes on the test database and refuses production. */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { prepareDb } from '../db/helpers'

const ready = await prepareDb()
const hasTools = spawnSync('pg_dump', ['--version']).status === 0 && spawnSync('pg_restore', ['--version']).status === 0

describe.skipIf(!ready || !hasTools)('restore rehearsal', () => {
  it('dumps, restores into a fresh database and verifies row counts, RLS and the audit hash chain (exit 0)', () => {
    const r = spawnSync('bash', ['scripts/restore-rehearsal.sh', process.env.DATABASE_URL!], { encoding: 'utf8', timeout: 240_000 })
    expect(r.stdout).toMatch(/row counts identical: \d+ tables/)
    expect(r.stdout).toMatch(/RLS flags and policies identical/)
    expect(r.stdout).toMatch(/unknown organization's session reads 0 rows in \d+ org-scoped tables/)
    expect(r.stdout).toMatch(/chains, \d+ rows, broken: 0/)
    expect(r.stdout).toMatch(/RESTORE REHEARSAL PASSED/)
    expect(r.status, r.stderr.slice(-2000)).toBe(0)
  }, 300_000)

  it('refuses a Supabase source without --confirm-production (exit 2)', () => {
    const r = spawnSync('bash', ['scripts/restore-rehearsal.sh', 'postgres://postgres.abc:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/refusing/)
  })
})
