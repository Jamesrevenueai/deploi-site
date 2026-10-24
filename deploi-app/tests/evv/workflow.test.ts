import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { correctException, dismissException, reopenException } from '../../lib/evv/workflow'
import { listExceptions, exceptionCounts, billingHold } from '../../lib/evv/queries'
import { heldConversations } from '../../lib/evv/gate'
import { CONNECTORS, NotImplemented } from '../../lib/evv/connectors'

const ready = await prepareDb()

describe.skipIf(!ready)('EVV fix workflow, tenancy and gate', () => {
  it('seeded Buckeye has 9 open exceptions sorted soonest-first, and the client sees the same list', async () => {
    const staff = await withUser(SESSIONS.staff, db => listExceptions(db, AGENCY_A, 'open'))
    const client = await withUser(SESSIONS.clientA, db => listExceptions(db, AGENCY_A, 'open'))
    expect(staff.length).toBe(9)
    expect(client.map(e => e.id)).toEqual(staff.map(e => e.id))
    const dl = staff.map(e => e.days_left!)
    expect([...dl].sort((a, b) => a - b)).toEqual(dl)
    expect(staff[0].client_initials).toMatch(/^[A-Z]\.[A-Z]\.$/)
  })

  it('a client of agency B cannot see agency A exceptions or billing hold', async () => {
    const list = await withUser(SESSIONS.clientB, db => listExceptions(db, AGENCY_A, 'open'))
    const hold = await withUser(SESSIONS.clientB, db => billingHold(db, AGENCY_A))
    expect(list.length).toBe(0)
    expect(hold.length).toBe(0)
  })

  it('mark corrected closes the row with a note and removes the visit from billing hold; morning report counts it as fixed today', async () => {
    const [first] = await withUser(SESSIONS.clientA, db => listExceptions(db, AGENCY_A, 'open'))
    const ok = await withUser(SESSIONS.clientA, db => correctException(db, first.id, 'Fixed clock-out in Sandata visit maintenance'))
    expect(ok).toBe(true)
    await expect(withUser(SESSIONS.clientA, db => correctException(db, first.id, ''))).rejects.toThrow()
    const row = await admin(db => db.one<{ status: string; corrected_at: string; correction_note: string }>('select status, corrected_at, correction_note from evv_exceptions where id = $1', [first.id]))
    expect(row?.status).toBe('corrected')
    expect(new Date(row!.corrected_at).toDateString()).toBe(new Date().toDateString())
    const hold = await withUser(SESSIONS.clientA, db => billingHold(db, AGENCY_A))
    expect(hold.some(h => h.visit_id === first.visit_id)).toBe(false)
    const counts = await withUser(SESSIONS.clientA, db => exceptionCounts(db, AGENCY_A))
    expect(counts).toMatchObject({ open: 8, corrected: 1 })
    expect(await withUser(SESSIONS.clientA, db => reopenException(db, first.id))).toBe(true)
  })

  it('dismiss needs a note and a client of another agency cannot close it', async () => {
    const [first] = await withUser(SESSIONS.staff, db => listExceptions(db, AGENCY_A, 'open'))
    expect(await withUser(SESSIONS.clientB, db => dismissException(db, first.id, 'not mine'))).toBe(false)
    expect(await withUser(SESSIONS.staff, db => dismissException(db, first.id, 'Duplicate of vendor ticket 4411'))).toBe(true)
    expect(await withUser(SESSIONS.staff, db => reopenException(db, first.id))).toBe(true)
  })

  it('gate counts held owner conversations from the seed', async () => {
    const n = await withUser(SESSIONS.staff, db => heldConversations(db))
    expect(n).toBe(5)
  })

  it('every connector stub throws NotImplemented with a clear message', async () => {
    expect(CONNECTORS.map(c => c.vendor)).toEqual(['sandata', 'alayacare', 'hhaexchange', 'wellsky'])
    expect(CONNECTORS[0].status).toBe('first')
    for (const c of CONNECTORS) {
      await expect(c.fetchVisits(new Date())).rejects.toBeInstanceOf(NotImplemented)
      await expect(c.fetchVisits(new Date())).rejects.toThrow(/docs\/evv-connectors\.md/)
    }
  })
})
