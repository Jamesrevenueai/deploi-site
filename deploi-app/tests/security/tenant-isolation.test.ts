/**
 * Cross-tenant isolation, generated from the catalog: for EVERY org-scoped table in `public`, a row is
 * seeded for organization B and organization A's session (signed-in profile, and an embedded Shopify
 * session carrying only an org claim) must read 0 of B's rows, while B's own session reads it.
 * Seeding runs in one transaction that is rolled back; foreign keys and triggers are suspended with the
 * owner's replication role so any table can be seeded without its parents.
 */
import { describe, it, expect } from 'vitest'
import type { Client } from 'pg'
import { prepareDb, SESSIONS, ORG_NW, ORG_HB } from '../db/helpers'
import { withOwner, publicTables, orgColumn } from './pg'

const ready = await prepareDb()

type Col = { name: string; type: string; udt: string; nullable: boolean; hasDefault: boolean; generated: boolean }

async function columns(c: Client, table: string): Promise<Col[]> {
  const r = await c.query<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; is_identity: string; is_generated: string }>(
    `select column_name, data_type, udt_name, is_nullable, column_default, is_identity, is_generated from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])
  return r.rows.map(x => ({ name: x.column_name, type: x.data_type, udt: x.udt_name, nullable: x.is_nullable === 'YES', hasDefault: x.column_default !== null || x.is_identity === 'YES', generated: x.is_generated === 'ALWAYS' }))
}

/** A literal the column's CHECK constraints accept, when one names it (first quoted literal after the column name). */
async function checkLiterals(c: Client, table: string): Promise<Map<string, string>> {
  const r = await c.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and contype = 'c'`, [table])
  const out = new Map<string, string>()
  for (const { def } of r.rows) {
    const m = /\(\(?\(?([a-z_0-9]+)\)?(?:::text)?\s*(?:=|~)\s*(?:ANY\s*\(\s*\(?ARRAY\[)?'([^']*)'/i.exec(def)
    if (m && !out.has(m[1])) out.set(m[1], m[2])
  }
  return out
}

async function valueFor(c: Client, col: Col, lits: Map<string, string>): Promise<string> {
  const lit = lits.get(col.name)
  // a regular-expression check (~ '^...$'): a 64-hex fingerprint or a short lowercase key satisfies the ones in use
  if (lit !== undefined && lit.startsWith('^')) return /\{64\}/.test(lit) ? `repeat('a', 64)` : `'ab'`
  if (lit !== undefined) return `'${lit.replace(/'/g, "''")}'`
  if (col.type === 'ARRAY') return `'{}'`
  if (col.type === 'USER-DEFINED') {
    const e = await c.query<{ enumlabel: string }>(`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`, [col.udt])
    return e.rows[0] ? `'${e.rows[0].enumlabel}'::${col.udt}` : 'null'
  }
  switch (col.udt) {
    case 'uuid': return 'gen_random_uuid()'
    case 'text': case 'varchar': case 'citext': case 'bpchar': return `'x' || substr(md5(random()::text), 1, 12)`
    case 'bool': return 'false'
    case 'int2': case 'int4': case 'int8': case 'numeric': case 'float4': case 'float8': return '1'
    case 'json': case 'jsonb': return `'{}'`
    case 'timestamptz': case 'timestamp': case 'date': return 'now()'
    case 'time': case 'timetz': return `'12:00'`
    case 'interval': return `'1 hour'`
    case 'bytea': return `'\\x00'`
    case 'inet': return `'192.0.2.1'`
    default: return 'null'
  }
}

describe.skipIf(!ready)('cross-tenant isolation of every org-scoped table', () => {
  it("organization A reads none of organization B's rows in any org-scoped table; B reads its own", async () => {
    await withOwner(async c => {
      const tables = (await publicTables(c)).map(t => ({ t: t.table, col: orgColumn(t) })).filter((x): x is { t: string; col: string } => Boolean(x.col))
      expect(tables.length).toBeGreaterThan(30)
      await c.query('begin')
      try {
        await c.query('set local session_replication_role = replica')
        const unseeded: string[] = []
        const seeded: { t: string; col: string; id: string | null }[] = []
        for (const { t, col } of tables) {
          const cols = await columns(c, t)
          const lits = await checkLiterals(c, t)
          const names: string[] = [], values: string[] = []
          for (const k of cols) {
            if (k.generated) continue
            if (k.name === col) { names.push(k.name); values.push(`'${ORG_HB}'`); continue }
            if (k.nullable || k.hasDefault) continue
            names.push(k.name); values.push(await valueFor(c, k, lits))
          }
          const hasId = cols.some(k => k.name === 'id')
          await c.query('savepoint s')
          try {
            // on a unique conflict B already has such a row, which serves the test just as well
            const r = await c.query(`insert into ${JSON.stringify(t)} (${names.map(n => JSON.stringify(n)).join(', ')}) values (${values.join(', ')}) on conflict do nothing${hasId ? ' returning id::text' : ''}`)
            seeded.push({ t, col, id: hasId && r.rows[0] ? String(r.rows[0].id) : null })
            await c.query('release savepoint s')
          } catch (e) {
            await c.query('rollback to savepoint s')
            unseeded.push(`${t}: ${(e as Error).message.slice(0, 120)}`)
          }
        }
        expect(unseeded).toEqual([])
        await c.query('set local role authenticated')
        const as = async (claims: Record<string, unknown>, q: string, params: unknown[]) => {
          await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
          await c.query('savepoint r')
          try { const r = await c.query<{ n: string }>(q, params); await c.query('release savepoint r'); return Number(r.rows[0].n) }
          catch { await c.query('rollback to savepoint r'); return -1 } // permission denied: nothing readable
        }
        const A_PROFILE = { sub: SESSIONS.northwind.uid, role: 'authenticated', email: SESSIONS.northwind.email }
        const A_SHOPIFY = { role: 'authenticated', org_id: ORG_NW, actor: 'test:shopify' }
        const B_PROFILE = { sub: SESSIONS.harbor.uid, role: 'authenticated', email: SESSIONS.harbor.email }
        const leaks: string[] = [], ownInvisible: string[] = []
        for (const s of seeded) {
          const q = `select count(*)::text as n from ${JSON.stringify(s.t)} where ${JSON.stringify(s.col)} = $1`
          for (const [who, claims] of [['A profile', A_PROFILE], ['A shopify', A_SHOPIFY]] as const) {
            const n = await as(claims, q, [ORG_HB])
            if (n > 0) leaks.push(`${s.t}: ${who} reads ${n} of B's rows`)
          }
          // the owner sees its seeded row (proves the row exists and the policy is the one being tested)
          if (s.col === 'org_id' || s.col === 'agency_id') {
            const own = await as(B_PROFILE, `select count(*)::text as n from ${JSON.stringify(s.t)} where ${JSON.stringify(s.col)} = $1${s.id ? ' and id::text = $2' : ''}`, s.id ? [ORG_HB, s.id] : [ORG_HB])
            if (own === 0) ownInvisible.push(s.t)
          }
        }
        expect(leaks).toEqual([])
        // tables whose rows the owning merchant cannot read either (staff-only or server-only data) are listed for review
        expect(ownInvisible.filter(t => !['library_chat_messages'].includes(t))).toEqual([])
      } finally {
        await c.query('rollback')
      }
    })
  })

  it('organizations, profiles and the audit log do not leak across tenants', async () => {
    await withOwner(async c => {
      await c.query('begin')
      try {
        await c.query('set local role authenticated')
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: SESSIONS.northwind.uid, role: 'authenticated' })])
        expect((await c.query(`select id from agencies where id = $1`, [ORG_HB])).rowCount).toBe(0)
        expect((await c.query(`select id from profiles where agency_id = $1`, [ORG_HB])).rowCount).toBe(0)
        expect((await c.query(`select id from audit_events`)).rowCount).toBe(0)
      } finally { await c.query('rollback') }
    })
  })
})
