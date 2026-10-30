/**
 * Fills the care tables of a REHEARSAL database with synthetic rows (two per table, every value marked synthetic)
 * so the archive can be proven on tables that hold data. Refuses any host that is not local.
 *
 *   npx tsx scripts/archive-rehearsal-seed.ts postgres://postgres:postgres@127.0.0.1:5432/<db>
 */
import { Client } from 'pg'
import { CARE_TABLES } from './archive-care-tables'

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
type Col = { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; is_generated: string }

export async function seedCareTables(url: string, perTable = 2) {
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing to seed a non-local database (${host})`)
  const c = new Client({ connectionString: url }); await c.connect()
  const seeded: Record<string, number> = {}, failed: Record<string, string> = {}
  try {
    const tables = (await c.query<{ tablename: string }>('select tablename from pg_tables where schemaname = $1 and tablename = any($2::text[])', ['public', [...CARE_TABLES]])).rows.map(r => r.tablename)
    // Multi-pass so parents are filled before children.
    for (let pass = 0; pass < 8; pass++) {
      for (const t of tables) {
        if (seeded[t]) continue
        try { seeded[t] = await seedOne(c, t, perTable); delete failed[t] } catch (e) { failed[t] = String((e as Error).message).split('\n')[0] }
      }
    }
  } finally { await c.end() }
  return { seeded: Object.fromEntries(Object.entries(seeded).filter(([, n]) => n > 0)), failed: Object.fromEntries(Object.entries(failed).filter(([t]) => !seeded[t])) }
}

async function seedOne(c: Client, t: string, n: number): Promise<number> {
  await c.query('begin')
  try { const made = await seedRows(c, t, n); await c.query('commit'); return made } catch (e) { await c.query('rollback'); throw e }
}

async function seedRows(c: Client, t: string, n: number): Promise<number> {
  const cols = (await c.query<Col>(
    `select column_name, data_type, udt_name, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t])).rows
  const fks = (await c.query<{ col: string; ptable: string; pcol: string }>(
    `select a.attname col, confrelid::regclass::text ptable, pa.attname pcol from pg_constraint k
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1] join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = k.confkey[1]
     where k.contype = 'f' and k.conrelid = $1::regclass and array_length(k.conkey, 1) = 1`, [`public.${t}`])).rows
  let made = 0
  for (let i = 0; i < n; i++) {
    const names: string[] = [], vals: string[] = []
    let blocked = false
    for (const col of cols) {
      if (col.is_generated === 'ALWAYS') continue
      const fk = fks.find(f => f.col === col.column_name)
      if (fk) {
        const cnt = Number((await c.query<{ n: string }>(`select count(*)::text n from ${fk.ptable}`)).rows[0].n)
        if (cnt === 0) { if (col.is_nullable === 'NO') { blocked = true; break } continue }
        names.push(q(col.column_name)); vals.push(`(select ${q(fk.pcol)} from ${fk.ptable} order by 1 limit 1 offset ${i % cnt})`); continue
      }
      if (col.column_default !== null || col.is_nullable === 'YES') continue
      names.push(q(col.column_name)); vals.push(await literal(c, t, col, i))
    }
    if (blocked) throw new Error('parent rows missing')
    await c.query('savepoint s')
    try {
      await c.query(names.length ? `insert into ${q(t)} (${names.join(',')}) values (${vals.join(',')})` : `insert into ${q(t)} default values`)
      await c.query('release savepoint s'); made++
    } catch (e) { await c.query('rollback to savepoint s'); if (!made) throw e }
  }
  return made
}

async function literal(c: Client, t: string, col: Col, i: number): Promise<string> {
  const tag = `synthetic-${t}-${i}-${Math.random().toString(36).slice(2, 8)}`
  switch (col.data_type) {
    case 'uuid': return 'gen_random_uuid()'
    case 'text': case 'character varying': case 'character': return `'${tag}'`
    case 'integer': case 'bigint': case 'smallint': return String(i + 1)
    case 'numeric': case 'double precision': case 'real': return String(i + 1)
    case 'boolean': return 'false'
    case 'date': return 'current_date'
    case 'timestamp with time zone': case 'timestamp without time zone': return 'now()'
    case 'time without time zone': return "'09:00'"
    case 'interval': return "'1 hour'"
    case 'jsonb': case 'json': return "'{}'"
    case 'ARRAY': return "'{}'"
    case 'USER-DEFINED': {
      const r = await c.query<{ enumlabel: string }>('select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = $1 order by e.enumsortorder limit 1', [col.udt_name])
      if (!r.rows.length) throw new Error(`no value for ${col.udt_name}`)
      return `'${r.rows[0].enumlabel}'`
    }
    default: throw new Error(`no generator for ${col.data_type}`)
  }
}

if (process.argv[1] && /archive-rehearsal-seed\.ts$/.test(process.argv[1])) {
  const url = process.argv[2]
  if (!url) { console.error('usage: archive-rehearsal-seed.ts <local db url>'); process.exit(2) }
  seedCareTables(url).then(r => { console.log(`seeded ${Object.keys(r.seeded).length} tables, ${Object.values(r.seeded).reduce((a, b) => a + b, 0)} rows`); if (Object.keys(r.failed).length) console.log('not seeded:', r.failed) }).catch(e => { console.error(e.message); process.exit(1) })
}
