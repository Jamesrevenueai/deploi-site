/**
 * The scheduled jobs in vercel.json are an allowlist. The consulting crons (morning-pipeline, morning-report,
 * workers) must never come back: they email and text on a schedule and write to the retired care tables.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const ALLOWED = ['/api/cron/agents', '/api/cron/weekly-summary', '/api/cron/library', '/api/cron/jobs', '/api/cron/office',
  // operations (lib/ops): alert evaluation every 10 minutes, the daily retention pass, the hourly health snapshot
  '/api/cron/alerts', '/api/cron/retention', '/api/cron/health',
  // owner updates (lib/notify): the daily morning report to owners and admins, held unless EMAIL_LIVE_SENDS allows
  '/api/cron/daily-report',
  // agent events: the 15-minute sweep (one sweep event per active organization) and the event jobs it runs
  '/api/cron/sweep']
const RETIRED = ['/api/cron/morning-pipeline', '/api/cron/morning-report', '/api/cron/workers']

describe('vercel.json crons', () => {
  const crons: { path: string; schedule: string }[] = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).crons ?? []

  it('lists only the agent platform jobs', () => {
    expect(crons.map(c => c.path).sort()).toEqual([...ALLOWED].sort())
  })
  it('lists none of the retired consulting jobs', () => {
    for (const r of RETIRED) expect(crons.map(c => c.path)).not.toContain(r)
  })
  it('points every cron at a route that exists, and the retired routes are gone', () => {
    for (const c of crons) expect(existsSync(join(ROOT, 'app', c.path, 'route.ts')), c.path).toBe(true)
    for (const r of RETIRED) expect(existsSync(join(ROOT, 'app', r, 'route.ts')), r).toBe(false)
  })
})
