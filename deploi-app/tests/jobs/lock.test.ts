import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { withJobLock } from '../../lib/jobs/lock'

const ready = await prepareDb()

describe.skipIf(!ready)('job lock', () => {
  it('runs once per period and skips the duplicate, even when attempted concurrently', async () => {
    const period = `test-${Date.now()}`
    let runs = 0
    const [a, b] = await Promise.all([
      admin(db => withJobLock(db, 'unit', period, async () => { runs++; return { n: 1 } })),
      admin(db => withJobLock(db, 'unit', period, async () => { runs++; return { n: 2 } })),
    ])
    expect(runs).toBe(1)
    expect([a.skipped, b.skipped].sort()).toEqual([false, true])
    const again = await admin(db => withJobLock(db, 'unit', period, async () => { runs++; return { n: 3 } }))
    expect(again.skipped).toBe(true)
    expect(runs).toBe(1)
  })
  it('a failed run is recorded and does not rerun in the same period', async () => {
    const period = `fail-${Date.now()}`
    const r = await admin(db => withJobLock(db, 'unit', period, async () => { throw new Error('boom') }))
    expect(r.skipped).toBe(false)
    expect((r as { error?: string }).error).toBe('boom')
    const row = await admin(db => db.one<{ status: string }>("select status from job_runs where job_key = 'unit' and period_key = $1", [period]))
    expect(row?.status).toBe('failed')
  })
})
