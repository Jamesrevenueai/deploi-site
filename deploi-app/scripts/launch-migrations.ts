/**
 * Release migration sets, applied and rolled back as a unit. --set=2026-10-28 (default) is the first launch,
 * --set=2026-11-04 is the full-platform release (org products, Shopify ops, WooCommerce, durable execution,
 * Deploi Office, customer experience, legal and billing, integration hardening), which needs the first set applied.
 *
 * Launch migrations 20261028000028 .. 20261030000035 (merchant engine, early access, agents, email,
 * agent platform, store access, competitor watch, agent library, role switch grants), and their rollback. Each file runs in its own transaction and is recorded in
 * _migrations, exactly like scripts/migrate.ts.
 *
 *   npx tsx scripts/launch-migrations.ts status   --db <url>
 *   npx tsx scripts/launch-migrations.ts dry-run  --db <url>   # apply all in ONE transaction, then roll it back
 *   npx tsx scripts/launch-migrations.ts apply    --db <url>
 *   npx tsx scripts/launch-migrations.ts rollback --db <url> [--discard-data]
 *
 * Where Postgres ports are unreachable, the same commands run over the Supabase Management API (HTTPS) with
 * --http=<project-ref> in place of --db (SUPABASE_ACCESS_TOKEN, or a proxy that adds it). Each step is one request, so a
 * dry run, an apply and a rollback are each one transaction there. Only this LAUNCH list runs: never the retired
 * consulting migrations, and never the consulting migrations 017-027 a plain migrate would add.
 *
 * Fail closed:
 *  - the target is never taken from the environment; --db is required;
 *  - a Supabase host (or DEPLOI_ENV=production) is refused unless --confirm-production=<project-ref>
 *    names that exact project: production needs the owner's explicit approval;
 *  - apply needs 20261020000016 already applied (the foundation: organizations, profiles, audit, sign-in bootstrap).
 *    It does NOT need the consulting migrations 20261021000017..027: the launch migrations apply on the foundation alone
 *    (tested for every cut-off from 20261020000001 to 20261021000027), and production's logs show it is behind 022;
 *  - rollback runs in ONE transaction and refuses to drop tables holding rows unless --discard-data is
 *    given; a refusal leaves every launch migration in place.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

export const LAUNCH = ['20261028000028_merchant_engine.sql', '20261028000029_early_access_leads.sql', '20261028000030_agents.sql', '20261028000031_email.sql', '20261028000032_agent_platform.sql', '20261029000032_store_access.sql', '20261029000033_competitor_watch.sql', '20261029000034_agent_library.sql', '20261030000035_role_switch_grants.sql']
const PREREQ = '20261020000016_service_role_auth_users.sql'
export const RELEASE_2026_11_04 = ['20261104000036_org_products.sql', '20261104000037_shopify_ops.sql', '20261104000038_woocommerce.sql', '20261104000039_durable_execution.sql', '20261104000040_office.sql', '20261104000041_customer_experience.sql', '20261104000042_legal_billing.sql', '20261104000043_integration_hardening.sql', '20261104000044_rate_limits.sql']
export const RELEASE_2026_11_05 = ['20261105000045_resolution_engine.sql', '20261105000046_purchase_orders.sql', '20261105000047_office_resolution.sql', '20261105000048_quickbooks_receivables.sql', '20261105000049_discovery.sql', '20261105000051_platform.sql']
export const RELEASE_2026_11_06 = ['20261106000052_cases_everywhere.sql', '20261106000053_members_support.sql', '20261106000054_inbox_reading.sql', '20261106000055_connection_health.sql', '20261106000056_billing_lifecycle.sql', '20261106000057_operations.sql']
export const SETS: Record<string, { files: string[]; prereq: string }> = {
  '2026-10-28': { files: LAUNCH, prereq: PREREQ },
  '2026-11-04': { files: RELEASE_2026_11_04, prereq: LAUNCH[LAUNCH.length - 1] },
  '2026-11-05': { files: RELEASE_2026_11_05, prereq: RELEASE_2026_11_04[RELEASE_2026_11_04.length - 1] },
  '2026-11-06': { files: RELEASE_2026_11_06, prereq: RELEASE_2026_11_05[RELEASE_2026_11_05.length - 1] },
}
export function setFrom(argv: string[] = process.argv) {
  const k = argv.find(a => a.startsWith('--set='))?.slice(6) ?? '2026-10-28'
  const s = SETS[k]
  if (!s) throw new Error(`unknown migration set ${k} (known: ${Object.keys(SETS).join(', ')})`)
  return s
}
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

export async function status(url: string, set = SETS['2026-10-28']) {
  const c = new Client({ connectionString: url }); await c.connect()
  try { const a = await applied(c); return { prerequisite: a.has(set.prereq), launch: set.files.map(f => ({ file: f, applied: a.has(f) })) } } finally { await c.end() }
}

export async function apply(url: string, opts: { dryRun?: boolean } = {}, set = SETS['2026-10-28']) {
  const c = new Client({ connectionString: url }); await c.connect()
  try {
    const a = await applied(c)
    if (!a.has(set.prereq)) throw new Error(`${set.prereq} is not applied: run the earlier migrations first`)
    const todo = set.files.filter(f => !a.has(f))
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

/** Migrations recorded after this set's last file: a set rolls back only once every later one is gone. */
export function laterApplied(applied: Iterable<string>, set: { files: string[] }): string[] {
  const last = [...set.files].sort().at(-1)!
  return [...applied].filter(f => f > last && !RETIRED_SAFE(f)).sort()
}
const RETIRED_SAFE = (f: string) => !/^\d{14}_/.test(f)
function assertNothingLater(applied: Iterable<string>, set: { files: string[] }) {
  const later = laterApplied(applied, set)
  if (later.length) throw new Error(`rollback refused: later migrations are applied (${later.join(', ')}); roll back the later release first`)
}

export async function rollback(url: string, opts: { discardData?: boolean } = {}, set = SETS['2026-10-28']) {
  const c = new Client({ connectionString: url }); await c.connect()
  try {
    const a = await applied(c)
    assertNothingLater(a, set)
    const undo = [...set.files].reverse().filter(f => a.has(f))
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

/** Runs one SQL text as one Management API request (the whole text is one transaction when it says so). */
export type SqlRunner = (sql: string) => Promise<Record<string, unknown>[]>

const ledger = 'create table if not exists _migrations (name text primary key, applied_at timestamptz default now());'
const record = (f: string) => `insert into _migrations (name) values ('${f.replace(/'/g, "''")}');`

export async function statusHttp(run: SqlRunner, set = SETS['2026-10-28']) {
  const a = new Set((await run(`${ledger} select name from _migrations`)).map(r => String(r.name)))
  return { prerequisite: a.has(set.prereq), launch: set.files.map(f => ({ file: f, applied: a.has(f) })) }
}

export async function applyHttp(run: SqlRunner, opts: { dryRun?: boolean } = {}, set = SETS['2026-10-28']) {
  const st = await statusHttp(run, set)
  if (!st.prerequisite) throw new Error(`${set.prereq} is not applied: run the earlier migrations first`)
  const todo = st.launch.filter(l => !l.applied).map(l => l.file)
  const body = (f: string) => `${readFileSync(join(ROOT, 'migrations', f), 'utf8')}\n;${record(f)}`
  if (opts.dryRun) {
    // everything in one transaction, rolled back; a probe row proves the statements ran before the rollback
    const rows = todo.length ? await run(`begin;\n${todo.map(body).join('\n')}\nselect count(*)::int as recorded from _migrations;\nrollback;`).catch(async e => { await run('rollback').catch(() => {}); throw e }) : []
    return { applied: todo, dryRun: true, probe: rows }
  }
  for (const f of todo) {
    try { await run(`begin;\n${body(f)}\ncommit;`) } catch (e) { await run('rollback').catch(() => {}); throw new Error(`${f}: ${(e as Error).message}`) }
  }
  return { applied: todo, dryRun: false }
}

export async function rollbackHttp(run: SqlRunner, opts: { discardData?: boolean } = {}, set = SETS['2026-10-28']) {
  assertNothingLater((await run(`${ledger} select name from _migrations`)).map(r => String(r.name)), set)
  const st = await statusHttp(run, set)
  const undo = [...st.launch].reverse().filter(l => l.applied).map(l => l.file)
  if (!undo.length) return { rolledBack: [] }
  const guard = readFileSync(join(ROOT, 'rollback', '_guard.sql'), 'utf8')
  const steps = undo.map(f => `${readFileSync(join(ROOT, 'rollback', f.replace(/\.sql$/, '.down.sql')), 'utf8')}\n;delete from _migrations where name = '${f}';`)
  try { await run(`begin;\n${opts.discardData ? "set local deploi.rollback_discard_data = 'on';\n" : ''}${guard}\n${steps.join('\n')}\ncommit;`) }
  catch (e) { await run('rollback').catch(() => {}); throw e }
  return { rolledBack: undo }
}

async function mainHttp(cmd: string, ref: string) {
  const confirm = process.argv.find(a => a.startsWith('--confirm-production='))?.split('=')[1]
  if (confirm !== ref) throw new Error(`refusing to touch Supabase project ${ref} without --confirm-production=${ref} (owner approval required)`)
  const { managementQueryFor } = await import('./supabase-http')
  const run: SqlRunner = sql => managementQueryFor(ref, sql)
  const set = setFrom()
  if (cmd === 'status') console.table((await statusHttp(run, set)).launch)
  else if (cmd === 'dry-run') console.log(await applyHttp(run, { dryRun: true }, set))
  else if (cmd === 'apply') console.log(await applyHttp(run, {}, set))
  else if (cmd === 'rollback') console.log(await rollbackHttp(run, { discardData: process.argv.includes('--discard-data') }, set))
  else throw new Error(`unknown command ${cmd}`)
}

async function main() {
  const [cmd] = process.argv.slice(2)
  const http = process.argv.find(a => a.startsWith('--http='))?.slice(7)
  if (http) return mainHttp(cmd, http)
  const db = process.argv.find(a => a.startsWith('--db='))?.slice(5) ?? process.argv[process.argv.indexOf('--db') + 1]
  if (!cmd || !db || db.startsWith('--')) throw new Error('usage: launch-migrations.ts <status|dry-run|apply|rollback> --db <url> [--set=2026-10-28|2026-11-04|2026-11-05]')
  assertTargetAllowed(db, process.argv)
  const set = setFrom()
  if (cmd === 'status') console.table((await status(db, set)).launch)
  else if (cmd === 'dry-run') console.log(await apply(db, { dryRun: true }, set))
  else if (cmd === 'apply') console.log(await apply(db, {}, set))
  else if (cmd === 'rollback') console.log(await rollback(db, { discardData: process.argv.includes('--discard-data') }, set))
  else throw new Error(`unknown command ${cmd}`)
}
if (process.argv[1] && /launch-migrations\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e.message); process.exit(1) })
