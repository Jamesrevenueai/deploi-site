import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A, AGENCY_B } from './helpers'
import { withUser, admin } from '../../lib/db'

const ready = await prepareDb()

describe.skipIf(!ready)('row-level security', () => {
  beforeAll(async () => { await prepareDb() })

  it('client user for agency A reads 0 of agency B visits', async () => {
    const rows = await withUser(SESSIONS.clientA, db => db.query('select id from visits where agency_id = $1', [AGENCY_B]))
    console.log(`RLS: client A reading agency B visits -> ${rows.length} rows`)
    expect(rows.length).toBe(0)
  })

  it('client user for agency A reads only own-agency visits even without a filter', async () => {
    const rows = await withUser(SESSIONS.clientA, db => db.query<{ agency_id: string }>('select agency_id from visits'))
    expect(rows.length).toBe(300)
    expect(rows.every(r => r.agency_id === AGENCY_A)).toBe(true)
  })

  it('client B sees exactly its 10 control visits', async () => {
    const rows = await withUser(SESSIONS.clientB, db => db.query('select id from visits'))
    expect(rows.length).toBe(10)
  })

  it('staff sees every agency', async () => {
    const rows = await withUser(SESSIONS.staff, db => db.query('select id from visits'))
    expect(rows.length).toBe(310)
  })

  it('client cannot read prospects, touches, or other profiles', async () => {
    const p = await withUser(SESSIONS.clientA, db => db.query('select id from prospects'))
    const t = await withUser(SESSIONS.clientA, db => db.query('select id from touches'))
    const pr = await withUser(SESSIONS.clientA, db => db.query('select id from profiles'))
    expect(p.length).toBe(0)
    expect(t.length).toBe(0)
    expect(pr.length).toBe(1)
  })

  it('client cannot insert a row into another agency', async () => {
    await expect(withUser(SESSIONS.clientA, db => db.query(
      "insert into referrals (agency_id, source_name, status) values ($1, 'x', 'new')", [AGENCY_B]))).rejects.toThrow()
  })

  it('client cannot read the audit log; staff can', async () => {
    const c = await withUser(SESSIONS.clientA, db => db.query('select id from audit_events'))
    const s = await withUser(SESSIONS.staff, db => db.query('select id from audit_events limit 5'))
    expect(c.length).toBe(0)
    expect(s.length).toBeGreaterThan(0)
  })

  it('writes by a client are audited with actor, agency and ip', async () => {
    const id = await withUser(SESSIONS.clientA, async db => {
      const r = await db.one<{ id: string }>("insert into referrals (agency_id, source_name, status) values ($1, 'audit test', 'new') returning id", [AGENCY_A])
      return r!.id
    }, { ip: '203.0.113.9' })
    const ev = await admin(db => db.one<{ actor_id: string; agency_id: string; action: string; ip: string }>(
      "select actor_id, agency_id, action, ip from audit_events where table_name = 'referrals' and row_id = $1 and action = 'insert'", [id]))
    expect(ev?.actor_id).toBe(SESSIONS.clientA.uid)
    expect(ev?.agency_id).toBe(AGENCY_A)
    expect(ev?.ip).toBe('203.0.113.9')
    await admin(db => db.query('delete from referrals where id = $1', [id]))
  })

  it('reads of client-side data are audited via audit_read', async () => {
    await withUser(SESSIONS.clientA, async db => {
      const v = await db.query<{ id: string }>('select id from visits limit 3')
      await db.auditRead('visits', AGENCY_A, v.map(x => x.id))
    })
    const n = await admin(db => db.one<{ n: string }>("select count(*)::text as n from audit_events where table_name = 'visits' and action = 'read' and actor_id = $1", [SESSIONS.clientA.uid]))
    expect(Number(n?.n)).toBeGreaterThanOrEqual(3)
  })

  it('anon role cannot touch tables but can create a lead through the definer function', async () => {
    const { anon } = await import('../../lib/db')
    await expect(anon(db => db.query('select id from prospects'))).rejects.toThrow()
    const id = await anon(db => db.one<{ id: string }>("select public_create_lead('Test','rls-lead@example.com','RLS Agency',null,'hi','site') as id"))
    expect(id?.id).toBeTruthy()
    await admin(db => db.query('delete from prospects where id = $1', [id!.id]))
  })
})
