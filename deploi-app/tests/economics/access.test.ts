import './env'
import { describe, it, expect, vi } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { encodeDevSession } from '../../lib/auth'
import { loadEconomicsOverview, loadRates, saveRate } from '../../lib/economics/queries'
import { PRETEND_MISSING } from '../../lib/dashboard/optional'

const ready = await prepareDb()
const INTERNAL = ['internal_rates', 'labor_entries', 'cost_entries', 'revenue_entries', 'service_tickets']

// The staff page runs requireRole('staff'); simulate a client's dev-session cookie and capture the redirect.
let cookieValue = ''
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'deploi_dev_session' ? { value: cookieValue } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`) },
  notFound: () => { throw new Error('NOT_FOUND') },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

describe.skipIf(!ready)('internal economics are staff-only', () => {
  it('a client session reads nothing from the internal tables (RLS)', async () => {
    for (const t of INTERNAL) {
      const rows = await withUser(SESSIONS.clientA, db => db.query(`select * from ${t}`))
      expect(rows, t).toEqual([])
    }
  })

  it('a client session cannot insert into the internal tables', async () => {
    await expect(withUser(SESSIONS.clientA, db => db.query("insert into labor_entries (agency_id, kind, hours) values ($1, 'review', 1)", [AGENCY_A]))).rejects.toThrow()
    await expect(withUser(SESSIONS.clientA, db => db.query("insert into revenue_entries (agency_id, kind, amount_cents, status) values ($1, 'other', 100, 'collected')", [AGENCY_A]))).rejects.toThrow()
    await expect(withUser(SESSIONS.clientA, db => db.query("update internal_rates set hourly_cents = 1"))).resolves.toEqual([])
    const rate = await withUser(SESSIONS.staff, db => db.one<{ hourly_cents: number }>("select hourly_cents from internal_rates where key = 'build_labor'"))
    expect(rate?.hourly_cents).toBeGreaterThan(1)
  })

  it('GET /staff/economics as a client redirects to the client home (requireRole)', async () => {
    cookieValue = encodeDevSession(SESSIONS.clientA)
    const { default: Page } = await import('../../app/staff/economics/page')
    await expect(Page()).rejects.toThrow('REDIRECT:/app/home')
    const { default: Rates } = await import('../../app/staff/economics/rates/page')
    await expect(Rates({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/app/home')
    const { default: Queue } = await import('../../app/staff/queue/page')
    await expect(Queue({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/app/home')
  })

  it('staff overview excludes the seeded mock payment and labels contribution', async () => {
    const ov = await withUser(SESSIONS.staff, db => loadEconomicsOverview(db))
    const a = ov.agencies.find(x => x.agencyId === AGENCY_A)!
    expect(a.name).toBe('Buckeye Home Care')
    expect(a.mockCount).toBe(1)
    expect(a.mockCents).toBe(99900)
    expect(a.collectedCents).toBe(150000 + 300000 + 75000)
    expect(a.projectedCents).toBe(75000)
    expect(a.hours.build).toBe(12.5)
    expect(a.costCents).toBe(2500 + 1800 + 4000 - 500)
    expect(a.label).toBe('Contribution (not net profit; excludes unrecorded overhead)')
    expect(a.contributionCents).toBe(a.collectedCents - a.laborCents - a.costCents)
    expect(a.supportHours).toBe(1.5)
    const eng = a.engagements.find(e => e.engagementRef === uuidFrom('engagement:buckeye:referral_response'))
    if (eng) { expect(eng.collectedSetupCents).toBe(300000); expect(eng.buildHours).toBe(12.5) }
    else expect(a.engagementsNote).toContain('not available yet')
  })

  it('degrades visibly when the parallel streams’ tables are missing', async () => {
    PRETEND_MISSING.add('engagements'); PRETEND_MISSING.add('website_engagements'); PRETEND_MISSING.add('proposed_actions.simulated')
    try {
      const ov = await withUser(SESSIONS.staff, db => loadEconomicsOverview(db))
      const a = ov.agencies.find(x => x.agencyId === AGENCY_A)!
      expect(a.engagements).toEqual([])
      expect(a.engagementsNote).toContain('not available yet')
      expect(a.completedWorkflows).toBeNull()
      expect(a.completedNote).toContain('not available yet')
      expect(ov.websites).toEqual([])
      expect(ov.websitesNote).toContain('not available yet')
    } finally { PRETEND_MISSING.clear() }
  })

  it('staff can edit a rate; the change is audited and reversible', async () => {
    const before = await withUser(SESSIONS.staff, db => loadRates(db))
    const old = before.rates.review_labor
    await withUser(SESSIONS.staff, db => saveRate(db, 'review_labor', 9900, SESSIONS.staff.uid))
    const after = await withUser(SESSIONS.staff, db => loadRates(db))
    expect(after.rates.review_labor).toBe(9900)
    const audit = await withUser(SESSIONS.staff, db => db.query("select 1 from audit_events where table_name = 'internal_rates' and row_id = 'review_labor' and action = 'update'"))
    expect(audit.length).toBeGreaterThan(0)
    await expect(withUser(SESSIONS.staff, db => saveRate(db, 'review_labor', -1, null))).rejects.toThrow()
    await withUser(SESSIONS.staff, db => saveRate(db, 'review_labor', old, SESSIONS.staff.uid))
  })
})
