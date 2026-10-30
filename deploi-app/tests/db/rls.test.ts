import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, SESSIONS, ORG_NW, ORG_HB } from './helpers'
import { withUser, admin } from '../../lib/db'

const ready = await prepareDb()

describe.skipIf(!ready)('row-level security', () => {
  beforeAll(async () => { await prepareDb() })

  it("a merchant reads its own store connection and never another organization's", async () => {
    const own = await withUser(SESSIONS.northwind, db => db.query<{ org_id: string }>('select org_id from store_connections'))
    expect(own.length).toBeGreaterThan(0)
    expect(own.every(r => r.org_id === ORG_NW)).toBe(true)
    const other = await withUser(SESSIONS.northwind, db => db.query('select id from store_connections where org_id = $1', [ORG_HB]))
    expect(other.length).toBe(0)
    const agents = await withUser(SESSIONS.northwind, db => db.query<{ org_id: string }>('select org_id from agents'))
    expect(agents.every(r => r.org_id === ORG_NW)).toBe(true)
  })

  it('staff sees every organization', async () => {
    const rows = await withUser(SESSIONS.staff, db => db.query<{ org_id: string }>('select distinct org_id from store_connections'))
    expect(rows.map(r => r.org_id)).toEqual(expect.arrayContaining([ORG_NW, ORG_HB]))
  })

  it('a merchant cannot write engine tables directly (writes go through the server)', async () => {
    await expect(withUser(SESSIONS.northwind, db => db.query(
      "update store_connections set status = 'disconnected' where org_id = $1", [ORG_NW]))).rejects.toThrow()
  })

  it('a merchant cannot read early access applications, other profiles, or the audit log; staff can', async () => {
    const p = await withUser(SESSIONS.northwind, db => db.query('select id from prospects'))
    const t = await withUser(SESSIONS.northwind, db => db.query('select id from touches'))
    const pr = await withUser(SESSIONS.northwind, db => db.query('select id from profiles'))
    const audit = await withUser(SESSIONS.northwind, db => db.query('select id from audit_events'))
    expect(p.length).toBe(0)
    expect(t.length).toBe(0)
    expect(pr.length).toBe(1)
    expect(audit.length).toBe(0)
    expect((await withUser(SESSIONS.staff, db => db.query('select id from audit_events limit 5'))).length).toBeGreaterThan(0)
  })

  it('the anon role cannot touch tables but can submit an early access application through the definer function', async () => {
    const { anon } = await import('../../lib/db')
    await expect(anon(db => db.query('select id from prospects'))).rejects.toThrow()
    const id = await anon(db => db.one<{ id: string }>("select public_create_early_access('Test','rls-lead@example.com','RLS Store','https://rls-store.example',array['shopify'],null,'hi') as id"))
    expect(id?.id).toBeTruthy()
    const staffSees = await withUser(SESSIONS.staff, db => db.query('select id from prospects where id = $1', [id!.id]))
    expect(staffSees.length).toBe(1)
    await admin(db => db.query('delete from prospects where id = $1', [id!.id]))
  })
})
