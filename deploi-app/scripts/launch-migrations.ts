/**
 * Launch migrations 20261028000028 .. 20261029000033 (merchant engine, early access, agents, email,
 * agent platform, store access, competitor watch), and their rollback. Each file runs in its own transaction and is recorded in
 * _migrations, exactly like scripts/migrate.ts.
 *
 *   npx tsx scripts/launch-migrations.ts status   --db <url>
 *   npx tsx scripts/launch-migrations.ts dry-run  --db <url>   # apply all in ONE transaction, then roll it back
 *   npx tsx scripts/launch-migrations.ts apply    --db <url>
 *   npx tsx scripts/launch-migrations.ts rollback --db <url> [--discard-data]
 *
 * Fail closed:
 *  - the target is never taken from the environment; --db is required;
 *  - a Supabase host (or DEPLOI_ENV=production) is refused unless --confirm-production=<project-ref>
 *    names that exact project: production needs the owner's explicit approval;
 *  - apply needs 20261021000027 already applied (the schema these build on);
 *  - rollback runs in ONE transaction and refuses to drop tables holding rows unless --discard-data is
 *    given; a refusal leaves every launch migration in place.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

export const LAUNCH = ['20261028000028_merchant_engine.sql', '20261028000029_early_access_leads.sql', '20261028000030_agents.sql', '20261028000031_email.sql', '20261028000032_agent_platform.sql', '20261029000032_store_access.sql', '20261029000033_competitor_watch.sql']
const PREREQ = '20261021000027_website.sql'
const ROOT = join(__dirname, '..', 'supabase')

export function productionRef(url: string): string | null {
  const u = new URL(url)
  const m = /^(?:db\.)?([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname) ?? /\.([a-z0-9]{20})$/.exec(u.username)
  if (m) return m[1]
  return /supabase\.(co|com)$/.test(u.hostname) ? 'unknown' : null
}

/** Refuse production unless the operator names the exact project. */
export function assertTargetAllowed(url: string, argv: string[], env: Record<string, string | undefined> = process.env) {
  const ref = productionRef(url)
  const confirm = argv.find(a => a.startsWith('--confirm-production='))?.split('=')[1] ?? null
  if ((ref || env.DEPLOI_ENV === 'production') && (!confirm || confirm !== ref)) {
    throw new Error(`refusing to touch ${ref ? `Supabase project ${ref}` : 'a production database'} without --confirm-production=${ref ?? '<project-ref>'} (owner approval required)`)
  }
}

async function applied(c: Client): Promise<Set<string>> {
  await c.query('create table if not exists _migrations (name text primary key, applied_at timestamptz default now())')
  return new Set((await c.query<{ name: string }>('select name from _migrations')).rows.map(r => r.name))
}

export async function status(url: string) {
  const c = new Client({ connectionString: url }); await c.connect()
  try { const a = await applied(c); return { prerequisite: a.has(PREREQ), launch: LAUNCH.map(f => ({ file: f, applied: a.has(f) })) } } finally { await c.end() }
}

export async function apply(url: string, opts: { dryRun?: boolean } = {}) {
  const c = new Client({ connectionString: url }); await c.connect()
  try {
    const a = await applied(c)
    if (!a.has(PREREQ)) throw new Error(`${PREREQ} is not applied: run the earlier migrations first`)
    const todo = LAUNCH.filter(f => !a.has(f))
    if (opts.dryRun) await c.query('begin')
    for (const f of todo) {
      if (!opts.dryRun) await c.query('begin')
      try {
        await c.query(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
        await c.query('insert into _migrations (name) values ($1)', [f])
        if (!opts.dryRun) await c.query('commit')
      } catch (e) { await c.query('rollback'); throw new Error(`${f}: ${(e as Error).message}`) }
    }
    if (opts.dryRun) await c.query('rollback')
    return { applied: todo, dryRun: Boolean(opts.dryRun) }
  } finally { await c.end() }
}

export async function rollback(url: string, opts: { discardData?: boolean } = {}) {
  const c = new Client({ connectionString: url }); await c.connect()
  try {
    const a = await applied(c)
    const undo = [...LAUNCH].reverse().filter(f => a.has(f))
    const guard = readFileSync(join(ROOT, 'rollback', '_guard.sql'), 'utf8')
    // all or nothing: a refusal at any step leaves every launch migration in place
    await c.query('begin')
    try {
      if (opts.discardData) await c.query(`set local deploi.rollback_discard_data = 'on'`)
      await c.query(guard)
      for (const f of undo) {
        try { await c.query(readFileSync(join(ROOT, 'rollback', f.replace(/\.sql$/, '.down.sql')), 'utf8')) } catch (e) { throw new Error(`${f} rollback: ${(e as Error).message}`) }
        await c.query('delete from _migrations where name = $1', [f])
      }
      await c.query('commit')
    } catch (e) { await c.query('rollback'); throw e }
    return { rolledBack: undo }
  } finally { await c.end() }
}

async function main() {
  const [cmd] = process.argv.slice(2)
  const db = process.argv.find(a => a.startsWith('--db='))?.slice(5) ?? process.argv[process.argv.indexOf('--db') + 1]
  if (!cmd || !db || db.startsWith('--')) throw new Error('usage: launch-migrations.ts <status|dry-run|apply|rollback> --db <url>')
  assertTargetAllowed(db, process.argv)
  if (cmd === 'status') console.table((await status(db)).launch)
  else if (cmd === 'dry-run') console.log(await apply(db, { dryRun: true }))
  else if (cmd === 'apply') console.log(await apply(db))
  else if (cmd === 'rollback') console.log(await rollback(db, { discardData: process.argv.includes('--discard-data') }))
  else throw new Error(`unknown command ${cmd}`)
}
if (process.argv[1] && /launch-migrations\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1) })
