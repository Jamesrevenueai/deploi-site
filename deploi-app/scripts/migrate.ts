/**
 * Applies supabase/migrations/*.sql in order to DATABASE_URL, tracking what ran
 * in _migrations. Idempotent. On plain Postgres (no auth schema) the local auth
 * shim is applied first so the same RLS policies run unchanged.
 *
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import 'dotenv/config'

export async function migrate(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required')
  const c = new Client({ connectionString: url })
  await c.connect()
  const hasAuth = (await c.query("select 1 from pg_namespace where nspname = 'auth'")).rowCount
  const onSupabase = (await c.query("select 1 from pg_roles where rolname = 'supabase_admin'")).rowCount
  if (!hasAuth && !onSupabase) {
    await c.query(readFileSync(join(process.cwd(), 'supabase/local/0000_auth_shim.sql'), 'utf8'))
    console.log('applied local auth shim')
  }
  await c.query('create table if not exists _migrations (name text primary key, applied_at timestamptz default now())')
  const dir = join(process.cwd(), 'supabase/migrations')
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  let applied = 0
  for (const f of files) {
    const done = await c.query('select 1 from _migrations where name = $1', [f])
    if (done.rowCount) continue
    await c.query('begin')
    try {
      await c.query(readFileSync(join(dir, f), 'utf8'))
      await c.query('insert into _migrations (name) values ($1)', [f])
      await c.query('commit')
      applied++
      console.log('applied', f)
    } catch (e) {
      await c.query('rollback')
      throw e
    }
  }
  console.log(`migrations: ${applied} applied, ${files.length - applied} already present`)
  await c.end()
}
if (process.argv[1] && /migrate\.ts$/.test(process.argv[1])) {
  migrate().catch(e => { console.error(e); process.exit(1) })
}
