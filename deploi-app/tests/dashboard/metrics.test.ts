import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { getMetrics } from '../../lib/dashboard/metrics'

const ready = await prepareDb()

describe.skipIf(!ready)('morning report metrics against the seed', () => {
  it('computes the six tiles for Buckeye Home Care', async () => {
    const m = await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    expect(m.agency.name).toBe('Buckeye Home Care')
    expect(m.shifts.open).toBe(6)
    expect(typeof m.shifts.medianMinutesToFill).toBe('number')
    expect(m.shifts.filledWeek).toBeGreaterThan(0)
    expect(m.exceptions.open).toBe(9)
    expect(m.exceptions.openItems.every(e => typeof e.daysLeft === 'number')).toBe(true)
    expect(m.exceptions.openItems[0].daysLeft).toBeLessThanOrEqual(m.exceptions.openItems[8].daysLeft!)
    expect(m.authorizations.total).toBe(40)
    expect(m.authorizations.lowCount).toBe(6)
    expect(m.authorizations.lowPct).toBe(15)
    expect(m.authorizations.expiring30).toBe(4)
    expect(m.applicants).toEqual({ new: 2, screened: 2, interviewsBooked: 1 })
    expect(m.credentials.lapsing30).toBeGreaterThanOrEqual(4)
    expect(m.referrals.week).toBeGreaterThanOrEqual(5)
    expect(typeof m.referrals.medianMinutes).toBe('number')
    expect(m.referrals.unanswered).toBe(1)
    expect(m.needsHuman.length).toBe(3)
    expect(m.needsHuman.map(h => h.kind)).toEqual(['exception', 'shift', 'authorization'])
  })

  it('audits every tile read', async () => {
    const before = await admin(db => db.one<{ n: string }>("select count(*) as n from audit_events where action = 'read' and actor_id = $1", [SESSIONS.clientA.uid]))
    await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    const after = await admin(db => db.one<{ n: string }>("select count(*) as n from audit_events where action = 'read' and actor_id = $1", [SESSIONS.clientA.uid]))
    expect(Number(after?.n) - Number(before?.n)).toBeGreaterThanOrEqual(6)
    const tables = await admin(db => db.query<{ table_name: string }>("select distinct table_name from audit_events where action = 'read' and actor_id = $1", [SESSIONS.clientA.uid]))
    for (const t of ['referrals', 'shifts', 'evv_exceptions', 'authorizations', 'applicants', 'aides']) expect(tables.map(x => x.table_name)).toContain(t)
  })

  it('client B gets its own (empty) numbers, never Buckeye data', async () => {
    const { AGENCY_B } = await import('../db/helpers')
    const m = await withUser(SESSIONS.clientB, db => getMetrics(db, AGENCY_B))
    expect(m.shifts.open).toBe(0)
    expect(m.exceptions.open).toBe(0)
    expect(m.authorizations.total).toBe(0)
  })
})
