/**
 * Applies supabase/migrations to the Supabase project over HTTPS and (with --seed) runs the seed.
 *   npx tsx scripts/migrate-http.ts [--seed]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { managementQuery, HttpSqlClient } from './supabase-http'
import { seed } from './seed'

async function main() {
  await managementQuery('create table if not exists _migrations (name text primary key, applied_at timestamptz default now())')
  const done = new Set((await managementQuery<{ name: string }>('select name from _migrations')).map(r => r.name))
  const dir = join(process.cwd(), 'supabase/migrations')
  let applied = 0
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) { console.log('present', f); continue }
    const sql = readFileSync(join(dir, f), 'utf8')
    await managementQuery(`begin;\n${sql}\ninsert into _migrations (name) values ('${f}');\ncommit;`)
    applied++; console.log('applied', f)
  }
  console.log(`migrations: ${applied} applied, ${done.size} already present`)
  if (process.argv.includes('--seed')) {
    const counts = await seed(undefined, { client: new HttpSqlClient() as never })
    console.log('seed:', counts)
  }
  const rows = await managementQuery<{ table: string; rows: number }>(
    `select c.relname as "table", (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.' || quote_ident(c.relname), false, true, '')))[1]::text::int as rows
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)
  console.table(rows)
}
main().catch(e => { console.error(e.message); process.exit(1) })
