import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { listTickets, getTicket, createTicket, updateTicket, ticketCounts, validateTicketInput, SUPPORT_COVERAGE_NOTE } from '../../lib/queue/tickets'

const ready = await prepareDb()

describe.skipIf(!ready)('service queue tickets under RLS', () => {
  it('seeded tickets are listed for staff, ordered open/in-progress first then severity', async () => {
    const rows = await withUser(SESSIONS.staff, db => listTickets(db, { status: 'active' }))
    const ids = rows.map(r => r.id)
    expect(ids).toContain(uuidFrom('ticket:0'))
    expect(ids).toContain(uuidFrom('ticket:1'))
    expect(ids.indexOf(uuidFrom('ticket:1'))).toBeLessThan(ids.indexOf(uuidFrom('ticket:0'))) // open before in_progress
    const counts = await withUser(SESSIONS.staff, db => ticketCounts(db))
    expect(counts.open).toBeGreaterThanOrEqual(1)
  })

  it('clients cannot read, create or change tickets', async () => {
    expect(await withUser(SESSIONS.clientA, db => listTickets(db))).toEqual([])
    expect(await withUser(SESSIONS.clientA, db => getTicket(db, uuidFrom('ticket:0')))).toBeNull()
    await expect(withUser(SESSIONS.clientA, db => createTicket(db, { agency_id: AGENCY_A, title: 'x' }, null))).rejects.toThrow()
    expect(await withUser(SESSIONS.clientA, db => updateTicket(db, uuidFrom('ticket:0'), { status: 'closed' }))).toBe(false)
    const t = await withUser(SESSIONS.staff, db => getTicket(db, uuidFrom('ticket:0')))
    expect(t?.status).toBe('in_progress')
  })

  it('staff create, edit, resolve and close a ticket; writes are audited', async () => {
    const id = await withUser(SESSIONS.staff, db => createTicket(db, { agency_id: AGENCY_A, title: 'Test ticket', severity: 'urgent', classification: 'defect', next_action: 'Look' }, SESSIONS.staff.uid), { ip: '203.0.113.5' })
    try {
      let t = await withUser(SESSIONS.staff, db => getTicket(db, id))
      expect(t).toMatchObject({ title: 'Test ticket', severity: 'urgent', classification: 'defect', status: 'open', resolved_at: null, agency_name: 'Buckeye Home Care' })
      expect(await withUser(SESSIONS.staff, db => updateTicket(db, id, { status: 'in_progress', owner: 'Deploi Staff' }))).toBe(true)
      expect(await withUser(SESSIONS.staff, db => updateTicket(db, id, { status: 'resolved', resolution: 'Fixed the mapping' }))).toBe(true)
      t = await withUser(SESSIONS.staff, db => getTicket(db, id))
      expect(t?.status).toBe('resolved'); expect(t?.resolved_at).toBeTruthy(); expect(t?.resolution).toBe('Fixed the mapping'); expect(t?.owner).toBe('Deploi Staff')
      expect(new Date(t!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(t!.created_at).getTime())
      await withUser(SESSIONS.staff, db => updateTicket(db, id, { status: 'open' }))
      expect((await withUser(SESSIONS.staff, db => getTicket(db, id)))?.resolved_at).toBeNull()
      const urgent = await withUser(SESSIONS.staff, db => listTickets(db, { severity: 'urgent', classification: 'defect', agency: AGENCY_A }))
      expect(urgent[0]?.id).toBe(id)
      const audit = await admin(db => db.query<{ action: string; ip: string }>("select action, ip from audit_events where table_name = 'service_tickets' and row_id = $1 order by at", [id]))
      expect(audit.map(a => a.action)).toContain('insert'); expect(audit.map(a => a.action)).toContain('update'); expect(audit[0].ip).toBe('203.0.113.5')
      await expect(withUser(SESSIONS.staff, db => updateTicket(db, id, { status: 'bogus' as never }))).rejects.toThrow('bad-status')
      await expect(withUser(SESSIONS.staff, db => updateTicket(db, id, { title: '  ' }))).rejects.toThrow('title-required')
    } finally {
      await admin(db => db.query('delete from service_tickets where id = $1', [id]))
    }
  })

  it('validates input and states the support-coverage rule', () => {
    expect(validateTicketInput({ agency_id: 'nope', title: 'x' })).toBe('agency-required')
    expect(validateTicketInput({ agency_id: AGENCY_A, title: ' ' })).toBe('title-required')
    expect(validateTicketInput({ agency_id: AGENCY_A, title: 'ok', severity: 'urgent' })).toBeNull()
    expect(SUPPORT_COVERAGE_NOTE).toMatch(/support hours/i)
    expect(SUPPORT_COVERAGE_NOTE).toMatch(/no continuous human coverage/i)
  })
})
