/**
 * Runs supabase/migrations against the Supabase project (deploi-prod) and seeds it.
 *   npm run db:migrate:prod            # migrations only
 *   npm run db:migrate:prod -- --seed  # migrations + idempotent seed
 * Reads SUPABASE_DATABASE_URL (the transaction-pooler URI from Project Settings → Database).
 * DDL is attempted in this order and the first host that accepts a connection is used:
 *   1. the pooler URI as given (port 6543, transaction mode)
 *   2. the same pooler host on port 5432 (session mode)
 *   3. the direct host db.<ref>.supabase.co:5432 (user "postgres")
 * The app itself keeps using the pooler URI.
 */
import { config } from 'dotenv'
config({ quiet: true }); config({ path: '.env.local', override: true, quiet: true })
import { Client } from 'pg'
import { migrate } from './migrate'
import { seed } from './seed'

export function candidateUrls(poolerUrl: string): { label: string; url: string }[] {
  const u = new URL(poolerUrl)
  const ref = u.username.includes('.') ? u.username.split('.')[1] : (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/^https?:\/\//, '').split('.')[0]
  const session = new URL(poolerUrl); session.port = '5432'
  const direct = new URL(poolerUrl); direct.hostname = `db.${ref}.supabase.co`; direct.port = '5432'; direct.username = 'postgres'
  return [
    { label: 'pooler 6543 (transaction)', url: u.toString() },
    { label: 'pooler 5432 (session)', url: session.toString() },
    { label: `direct db.${ref}.supabase.co:5432`, url: direct.toString() },
  ]
}

export function hasPlaceholderPassword(url: string): boolean {
  return /\[?PASSWORD[ _-]?HERE\]?|YOUR-PASSWORD|<password>/i.test(decodeURIComponent(url))
}

async function reachable(url: string): Promise<string | null> {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000 })
  try { await c.connect(); await c.query('select 1'); await c.end(); return null } catch (e) { await c.end().catch(() => {}); return (e as Error).message }
}

async function main() {
  const pooler = process.env.SUPABASE_DATABASE_URL ?? ''
  if (!pooler) throw new Error('SUPABASE_DATABASE_URL is not set')
  if (hasPlaceholderPassword(pooler)) throw new Error('SUPABASE_DATABASE_URL still contains the password placeholder')
  let chosen: { label: string; url: string } | null = null
  for (const c of candidateUrls(pooler)) {
    const err = await reachable(c.url)
    if (!err) { chosen = c; break }
    console.log(`skip ${c.label}: ${err.split('\n')[0]}`)
  }
  if (!chosen) throw new Error('no Postgres endpoint reachable (check network egress on 5432/6543 and the password)')
  console.log(`using ${chosen.label}`)
  await migrate(chosen.url)
  if (process.argv.includes('--seed')) console.log('seed:', await seed(chosen.url))
  const c = new Client({ connectionString: chosen.url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  const rows = await c.query(`select relname as table, n_live_tup as rows from pg_stat_user_tables where schemaname = 'public' order by relname`)
  console.table(rows.rows)
  await c.end()
}
if (process.argv[1] && /migrate-prod\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1) })
