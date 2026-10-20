import { describe, it, expect } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { buildMorningPipeline, isSevenAmEt, runMorningPipeline } from '../../lib/sales/morning'
import { renderMorningPipeline, morningPipelineText } from '../../emails/morning-pipeline'
import { mockOutbox } from '../../lib/adapters/email'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

// tests/setup.ts forces .env.test; allow a per-section database for parallel section work
if (process.env.SALES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.SALES_TEST_DATABASE_URL
const ready = await prepareDb()

describe('morning pipeline email', () => {
  it('knows 7am ET across DST', () => {
    expect(isSevenAmEt(new Date('2026-07-01T11:30:00Z'))).toBe(true)   // EDT
    expect(isSevenAmEt(new Date('2026-01-15T12:30:00Z'))).toBe(true)   // EST
    expect(isSevenAmEt(new Date('2026-01-15T11:30:00Z'))).toBe(false)
  })

  it.skipIf(!ready)('builds the four sections from the seed and renders html + text', async () => {
    const data = await admin(db => buildMorningPipeline(db))
    expect(data.conversations).toEqual({ held: 5, goal: 10 })
    expect(data.followUpsDue.length).toBeGreaterThan(0)
    const { html, text } = await renderMorningPipeline(data)
    expect(html).toContain('Morning pipeline')
    expect(html).toContain('5 / 10')
    expect(text).toContain('Owner conversations: 5 / 10')
    expect(morningPipelineText(data)).toContain('Follow-ups due')
  })

  it.skipIf(!ready)('sends once per day via the adapter and records a worker run', async () => {
    const before = mockOutbox.length
    const first = await runMorningPipeline({ force: true })
    expect(first.sent).toBe(true)
    expect(mockOutbox.length).toBe(before + 1)
    expect(mockOutbox[mockOutbox.length - 1].subject).toBe('Deploi — morning pipeline')
    const sevenToday = fromZonedTime(`${formatInTimeZone(new Date(), 'America/New_York', 'yyyy-MM-dd')}T07:30:00`, 'America/New_York')
    const skipped = await runMorningPipeline({ now: sevenToday })
    expect(skipped).toEqual({ sent: false, reason: 'already sent today' })
    const offHour = await runMorningPipeline({ now: new Date('2026-01-15T15:30:00Z') })
    expect(offHour).toEqual({ sent: false, reason: 'not 7am ET' })
    const runs = await admin(db => db.query("select id from worker_runs where worker = 'morning_pipeline'"))
    expect(runs.length).toBeGreaterThan(0)
  })
})
