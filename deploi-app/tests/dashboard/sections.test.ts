import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A, AGENCY_B } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { getMetrics } from '../../lib/dashboard/metrics'
import { getClientSections, toActionItems, CSV_NOTE } from '../../lib/dashboard/sections'
import { PRETEND_MISSING, tableExists } from '../../lib/dashboard/optional'

const ready = await prepareDb()

describe.skipIf(!ready)('client dashboard sections', () => {
  it('render with the optional tables present (engagements, pilots, imports, simulated column)', async () => {
    const has = await withUser(SESSIONS.staff, async db => ({ eng: await tableExists(db, 'engagements'), pil: await tableExists(db, 'pilots') }))
    const s = await withUser(SESSIONS.clientA, async db => getClientSections(db, AGENCY_A, await getMetrics(db, AGENCY_A)))
    if (has.eng) {
      // the engage seed puts Buckeye's referral_response engagement in pilot
      expect(s.services.rows.map(r => r.key)).toContain('referral_response')
      expect(s.services.rows[0].name).toBe('Referral response and follow-up')
      expect(s.services.rows[0].availabilityLabel).toBe('Demonstration')
      expect(s.limitations.rows[0].service).toBe('Referral response and follow-up')
      expect(s.limitations.rows[0].exclusions).toContain('No clinical eligibility decisions')
    } else {
      expect(s.services.note).toBe('No active services recorded yet.')
    }
    if (has.pil) { expect(s.pilot.available).toBe(true); if (!s.pilot.note) expect(s.pilot.metricKey).toBeTruthy() }
    expect(s.limitations.csvNote).toBe(CSV_NOTE)
    expect(s.freshness.anyStale).toBe(true) // the seed has no committed import
    expect(s.outcomes.shiftsFilled).toBeGreaterThan(0)
    expect(s.outcomes.referralsAnswered).toBeGreaterThanOrEqual(5)
    expect(s.outcomes.exceptionsCorrected).toBe(0)
    expect(s.outcomes.whatCounts.join(' ')).toMatch(/not fills|not responses|not a correction/)
    expect(s.activity.windowDays).toBe(30)
    expect(s.actionItems.items.length).toBeGreaterThanOrEqual(3)
    expect(s.actionItems.items.every(i => ['urgent', 'high', 'medium', 'low'].includes(i.level))).toBe(true)
    expect(s.actionItems.items.some(i => i.kind === 'freshness')).toBe(true)
  })

  it('degrades to "not available yet" states without the optional tables', async () => {
    for (const t of ['engagements', 'pilots', 'imports', 'website_engagements', 'proposed_actions.simulated']) PRETEND_MISSING.add(t)
    try {
      const s = await withUser(SESSIONS.clientA, async db => getClientSections(db, AGENCY_A, await getMetrics(db, AGENCY_A)))
      expect(s.services.rows).toEqual([])
      expect(s.services.note).toBe('No active services recorded yet.')
      expect(s.pilot.available).toBe(false)
      expect(s.pilot.note).toContain('not available yet')
      expect(s.freshness.importsNote).toContain('not available yet')
      expect(s.activity.available).toBe(false)
      expect(s.activity.note).toMatch(/not yet recorded/)
      expect(s.limitations.rows).toEqual([])
      expect(s.limitations.csvNote).toBe(CSV_NOTE)
    } finally { PRETEND_MISSING.clear() }
  })

  it('verified activity counts only delivered, non-simulated actions', async () => {
    const hasSim = await withUser(SESSIONS.staff, db => db.one("select 1 as ok from information_schema.columns where table_name = 'proposed_actions' and column_name = 'simulated'"))
    if (!hasSim) return
    const ids = await admin(db => db.query<{ id: string }>(
      `insert into proposed_actions (agency_id, worker, kind, body, status, simulated, dedupe_key, sent_at) values
         ($1, 'open_shift_fill', 'sms', 'x', 'delivered', false, 'sections-test-real', now()),
         ($1, 'open_shift_fill', 'sms', 'x', 'delivered', true, 'sections-test-sim', now()),
         ($1, 'referral_response', 'email', 'x', 'proposed', false, 'sections-test-draft', null)
       returning id`, [AGENCY_A]))
    try {
      const s = await withUser(SESSIONS.clientA, async db => getClientSections(db, AGENCY_A, await getMetrics(db, AGENCY_A)))
      expect(s.activity.available).toBe(true)
      expect(s.activity.byWorker.find(w => w.worker === 'open_shift_fill')?.n).toBe(1)
      expect(s.actionItems.pendingApprovals).toBeGreaterThanOrEqual(1)
      expect(s.actionItems.items.some(i => i.kind === 'approval' && i.level === 'medium')).toBe(true)
    } finally {
      await admin(db => db.query('delete from proposed_actions where id = any($1)', [ids.map(i => i.id)]))
    }
  })

  it('agency B sees its own empty state and nothing from Buckeye', async () => {
    const s = await withUser(SESSIONS.clientB, async db => getClientSections(db, AGENCY_B, await getMetrics(db, AGENCY_B)))
    expect(s.outcomes.shiftsFilled).toBe(0)
    expect(s.services.rows.every(r => r.key !== 'referral_response') || s.services.rows.length === 0).toBe(true)
    expect(s.freshness.lastWorkerRun === null || typeof s.freshness.lastWorkerRun.worker === 'string').toBe(true)
  })

  it('maps the needs-human list to signals the rules can read', async () => {
    const m = await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    const items = toActionItems(m)
    expect(items.map(i => i.kind)).toEqual(m.needsHuman.map(h => h.kind))
    const ex = items.find(i => i.kind === 'exception')
    expect(typeof ex?.signal.daysLeft).toBe('number')
    const sh = items.find(i => i.kind === 'shift')
    expect(typeof sh?.signal.hoursUntil).toBe('number')
  })
})
