/**
 * Tamper-evident audit trail: every engine_audit row is linked into its organization's hash chain at
 * commit; verification detects a changed row, a removed row (middle or end), and the table stays
 * append-only. Plus the owner-facing audit API pieces: filters, CSV export, chain check, isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { audit } from '../../lib/engine/audit'
import { auditCsv, searchAudit, verifyAuditChain, verifyOwnAuditChain, parseAuditFilters } from '../../lib/engine/audit-query'
import { merchantActor, staffActor } from '../merchant/helpers'
import { NW, HB } from './helpers'

const ready = await prepareDb()
let org = ''
let su: Client

async function write(n: number, prefix = 'test.chain') {
  for (let i = 0; i < n; i++) await admin(db => audit(db, { orgId: org, entityType: 'job', entityId: `e${i}`, event: `${prefix}.${i}`, actor: 'test', detail: { i, note: 'x' } }))
}
const rows = () => admin(db => db.query<{ id: string; chain_seq: string; prev_hash: string | null; row_hash: string }>('select id::text, chain_seq::text, prev_hash, row_hash from engine_audit e where org_id = $1 order by e.chain_seq', [org]))

beforeAll(async () => {
  if (!ready) return
  org = (await admin(db => db.one<{ id: string }>(`insert into agencies (name, org_type) values ('audit chain test', 'care_agency') returning id`)))!.id
  su = new Client({ connectionString: process.env.DATABASE_URL })
  await su.connect()
})
afterAll(async () => {
  if (!ready) return
  await su.query('delete from agencies where id = $1', [org])
  await su.query('delete from engine_audit_chain where chain_key = $1', [org])
  await su.end()
})

describe.skipIf(!ready)('audit hash chain', () => {
  it('links every row in commit order, including rows written concurrently and several in one transaction', async () => {
    await write(3)
    await admin(async db => { await audit(db, { orgId: org, entityType: 'job', event: 'test.tx.a', actor: 'test' }); await audit(db, { orgId: org, entityType: 'job', event: 'test.tx.b', actor: 'test' }) })
    await Promise.all(Array.from({ length: 8 }, (_, i) => admin(db => audit(db, { orgId: org, entityType: 'job', event: `test.par.${i}`, actor: 'test' }))))
    const r = await rows()
    expect(r).toHaveLength(13)
    expect(r.map(x => Number(x.chain_seq))).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
    expect(r[0].prev_hash).toBeNull()
    for (let i = 1; i < r.length; i++) expect(r[i].prev_hash).toBe(r[i - 1].row_hash)
    expect(await verifyAuditChain(org)).toEqual({ ok: true, checked: 13, brokenSeq: null, brokenId: null, reason: null })
  })

  it('is append-only: the service role cannot change or delete rows, and even the owner cannot update them', async () => {
    await expect(admin(db => db.query(`update engine_audit set actor = 'x' where org_id = $1`, [org]))).rejects.toThrow(/permission denied/)
    await expect(admin(db => db.query(`delete from engine_audit where org_id = $1`, [org]))).rejects.toThrow(/permission denied/)
    await expect(su.query(`update engine_audit set actor = 'x' where org_id = $1`, [org])).rejects.toThrow(/append-only/)
  })

  it('detects a changed row, and passes again once it is put back', async () => {
    const r = await rows()
    const target = r[4]
    const original = (await su.query('select detail::text as d from engine_audit where id = $1', [target.id])).rows[0].d as string
    // tampering below the application (triggers off, as a database superuser could)
    await su.query(`begin; set local session_replication_role = replica; update engine_audit set detail = '{"i":99}' where id = $1; commit;`.replace('$1', target.id))
    expect(await verifyAuditChain(org)).toMatchObject({ ok: false, brokenSeq: 5, brokenId: Number(target.id), reason: 'the row was changed after it was written' })
    await su.query('begin')
    await su.query('set local session_replication_role = replica')
    await su.query('update engine_audit set detail = $2::jsonb where id = $1', [target.id, original])
    await su.query('commit')
    expect((await verifyAuditChain(org)).ok).toBe(true)
  })

  it('detects a removed row in the middle and at the end', async () => {
    const r = await rows()
    await su.query(`begin; set local session_replication_role = replica; delete from engine_audit where id = ${r[r.length - 1].id}; commit;`)
    expect(await verifyAuditChain(org)).toMatchObject({ ok: false, reason: 'rows are missing from the end of the chain' })
    await su.query(`begin; set local session_replication_role = replica; delete from engine_audit where id = ${r[2].id}; commit;`)
    expect(await verifyAuditChain(org)).toMatchObject({ ok: false, brokenSeq: 3, reason: 'a row is missing from the chain' })
  })

  it('audit API: filters, CSV export (formula-safe), the organization\'s own chain, no cross-organization rows', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const ev = `test.csv${Date.now()}`
    await admin(db => audit(db, { orgId: NW.org, entityType: 'job', entityId: 'csv', event: `${ev}.export`, actor: '=HYPERLINK("x")', detail: { a: 'b,c' } }))
    const f = parseAuditFilters(new URLSearchParams(`event=${ev}&limit=10`))
    const found = await searchAudit(nw, f)
    expect(found.map(r => r.event)).toEqual([`${ev}.export`])
    expect(found[0].row_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await searchAudit(hb, f)).toEqual([])
    const csv = auditCsv(found)
    expect(csv.split('\r\n')[0]).toBe('id,at,event,entity_type,entity_id,actor,detail,chain_seq,row_hash')
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain('"{""a"":""b,c""}"')
    expect(() => parseAuditFilters(new URLSearchParams('event=x%27;drop'))).toThrow(/invalid event/)
    expect((await verifyOwnAuditChain(nw)).ok).toBe(true)
    await expect(verifyOwnAuditChain(await staffActor())).rejects.toThrow(/per organization/)
  })
})
