/**
 * The scheduled jobs in vercel.json are an allowlist. The consulting crons (morning-pipeline, morning-report,
 * workers) must never come back: they email and text on a schedule and write to the retired care tables.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const ALLOWED = ['/api/cron/agents', '/api/cron/weekly-summary', '/api/cron/library']
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
