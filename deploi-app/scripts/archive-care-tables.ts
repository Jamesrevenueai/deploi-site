/**
 * Archive (never drop) the tables and functions of the retired home-care consulting service.
 *
 *   npx tsx scripts/archive-care-tables.ts report  --db <url>                       # read only: tables, row counts, functions, blockers
 *   npx tsx scripts/archive-care-tables.ts dump    --db <url> --out <file>          # pg_dump of the care tables + row-count manifest + sha256
 *   npx tsx scripts/archive-care-tables.ts apply   --db <url> --dump <file>         # ONE transaction: move to schema "archive", revoke app roles, verify counts
 *   npx tsx scripts/archive-care-tables.ts verify  --db <url>                       # archived counts match the log; app roles cannot read or run anything in it
 *   npx tsx scripts/archive-care-tables.ts restore --db <url>                       # undo: move everything back and re-issue the grants
 *   npx tsx scripts/archive-care-tables.ts drop    --db <url> --confirm-drop        # only 30 days or more after apply
 *
 * Fail closed:
 *  - the target is never taken from the environment; --db is required, and a Supabase host (or DEPLOI_ENV=production)
 *    is refused unless --confirm-production=<project-ref> names that exact project;
 *  - apply needs a dump made from the same data: its manifest (row counts) must equal the live counts, and the
 *    dump's sha256 is recorded in archive._archive_log;
 *  - apply refuses if anything we keep depends on what it would move (foreign key, view, policy, trigger, or a function
 *    that mentions a care table). Moving a table keeps its rows, indexes, triggers and policies; it only changes the schema;
 *  - the move, the revoke and the count check run in one transaction, so any mismatch leaves public untouched;
 *  - the consulting-only database functions (CARE_FUNCTIONS, including the anonymous lead-intake functions) move with the
 *    tables and lose their execute rights; restore moves them back and re-issues the rights;
 *  - nothing is dropped by apply, restore or verify. `drop` refuses before 30 days;
 *  - scripts/migrate.ts skips the retired consulting migrations (scripts/retired-migrations.ts), so a later migrate run
 *    cannot recreate the archived tables.
 *
 * Tables and functions that do not exist on the target are skipped (production may be behind the full consulting schema).
 *
 * Where Postgres ports are unreachable, pass --http=<project-ref> instead of --db (Supabase Management API over HTTPS).
 * Reads are one request each. `dump` writes the care tables as JSON (plus the same manifest and sha256). `apply` and
 * `restore` send their whole transaction as ONE request; the checks `apply` makes inside its transaction (counts still equal
 * the dump before the move, equal after it, nothing left in public) are SQL assertions there, so any mismatch aborts it.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { Client } from 'pg'
import { assertTargetAllowed } from './launch-migrations'
import { literal, managementQueryFor } from './supabase-http'

/** Tables created for the consulting service (migrations 20261020000001 .. 20261021000027) that nothing now uses. */
export const CARE_TABLES = [
  'assessments', 'trace_steps', 'clients', 'aides', 'authorizations', 'shifts', 'shift_offers', 'visits', 'evv_exceptions',
  'referrals', 'applicants', 'proposed_actions', 'retention_checkins', 'worker_runs', 'evv_imports',
  'assessment_credits', 'assessment_credit_applications', 'engagements', 'engagement_transitions', 'onboarding_items',
  'pilots', 'pilot_measurements', 'job_runs', 'imports', 'visit_revisions', 'evv_rule_sets', 'internal_rates',
  'labor_entries', 'cost_entries', 'revenue_entries', 'service_tickets', 'website_engagements', 'website_labor', 'website_transitions',
] as const

/** Consulting-only database functions, moved to the archive schema with the tables. Most are SECURITY DEFINER and were callable by anon. */
export const CARE_FUNCTIONS = [
  'public_create_lead', 'public_create_lead_v2', 'website_strip_secret_keys', // the old consulting lead intake (the website now uses public_create_early_access)
  'suppress_pending_actions', 'agency_last_worker_run', 'retire_followups_on_change', 'audit_internal_rates_row', 'engagements_status_guard',
] as const

/** Created by the same migrations but still used: never archived. */
export const KEEP_TABLES = [
  'agencies',     // the organization table for merchants (org_type = 'merchant')
  'profiles',     // sign-in profiles
  'audit_events', // the audit log
  'prospects', 'touches', // early access applications (public_create_early_access)
  'invites',      // read by the auth trigger handle_new_user() and lib/auth.ts
  'settings',     // read by handle_new_user()
] as const

const SCHEMA = 'archive'
const MIN_AGE_DAYS = 30
const q = (s: string) => `"${s.replace(/"/g, '""')}"`

function arg(argv: string[], name: string) { return argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined) }

/** The subset of pg.Client used here, so the same reads also run over HTTPS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Conn = { query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>; end(): Promise<void> }

const HTTP = 'supabase-http:'
const httpRef = (target: string) => target.startsWith(HTTP) ? target.slice(HTTP.length) : null
const interpolate = (text: string, params: unknown[] = []) => text.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]))

async function connect(url: string): Promise<Conn> {
  const ref = httpRef(url)
  if (ref) return {
    query: async <T,>(text: string, params?: unknown[]) => ({ rows: await managementQueryFor<T>(ref, interpolate(text, params)) }),
    end: async () => {},
  }
  const c = new Client({ connectionString: url, ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined })
  await c.connect(); return c as unknown as Conn
}

export async function presentTables(c: Conn, schema = 'public'): Promise<string[]> {
  const r = await c.query<{ tablename: string }>('select tablename from pg_tables where schemaname = $1 and tablename = any($2::text[]) order by 1', [schema, [...CARE_TABLES]])
  return r.rows.map(x => x.tablename)
}

type Fn = { oid: string; name: string; args: string }
export async function presentFunctions(c: Conn): Promise<Fn[]> {
  return (await c.query<Fn>(
    `select p.oid::text oid, p.proname name, pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1::text[]) order by 2, 3`, [[...CARE_FUNCTIONS]])).rows
}
const sig = (schema: string, f: { name: string; args: string }) => `${schema}.${q(f.name)}(${f.args})`

export async function countRows(c: Conn, schema: string, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = Number((await c.query<{ n: string }>(`select count(*)::text as n from ${q(schema)}.${q(t)}`)).rows[0].n)
  return out
}

/** Everything that would break if the tables and functions moved. An empty list means it is safe. */
export async function blockers(c: Conn, tables: string[]): Promise<string[]> {
  const out: string[] = []
  for (const k of KEEP_TABLES) if (tables.includes(k)) out.push(`${k} is on the keep list but was selected`)
  if (tables.length) {
    const fk = await c.query<{ a: string; b: string }>(
      `select conrelid::regclass::text a, confrelid::regclass::text b from pg_constraint where contype = 'f' and confrelid::regclass::text = any($1::text[]) and conrelid::regclass::text <> all($1::text[])`, [tables])
    for (const r of fk.rows) out.push(`foreign key: ${r.a} references ${r.b}`)
    const views = await c.query<{ v: string; t: string }>(
      `select distinct c.relname v, d.refobjid::regclass::text t from pg_rewrite r join pg_depend d on d.objid = r.oid and d.classid = 'pg_rewrite'::regclass join pg_class c on c.oid = r.ev_class
       where d.refobjid::regclass::text = any($1::text[]) and c.oid <> d.refobjid`, [tables])
    for (const r of views.rows) out.push(`view ${r.v} reads ${r.t}`)
    const pol = await c.query<{ t: string; p: string }>(
      `select polrelid::regclass::text t, polname p from pg_policy where polrelid::regclass::text <> all($1::text[])
       and (coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) ~* ('\\m(' || array_to_string($1::text[], '|') || ')\\M')`, [tables])
    for (const r of pol.rows) out.push(`policy ${r.p} on ${r.t} mentions an archived table`)
    // A function that is not on the consulting list but mentions a care table: something we keep may rely on it.
    const fn = await c.query<{ f: string; m: string }>(
      `select p.oid::regprocedure::text f, (select string_agg(x, ',') from unnest($1::text[]) x where p.prosrc ~* ('\\m' || x || '\\M')) m
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname <> all($2::text[]) and p.prosrc ~* ('\\m(' || array_to_string($1::text[], '|') || ')\\M')`, [tables, [...CARE_FUNCTIONS]])
    for (const r of fn.rows) out.push(`function ${r.f} mentions ${r.m}`)
  }
  // A consulting function that a table we keep still uses (trigger or policy).
  const trg = await c.query<{ t: string; g: string; f: string }>(
    `select tgrelid::regclass::text t, tgname g, p.proname f from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
     where not tg.tgisinternal and p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[]) and tgrelid::regclass::text <> all($2::text[])`, [[...CARE_FUNCTIONS], tables])
  for (const r of trg.rows) out.push(`trigger ${r.g} on ${r.t} uses ${r.f}`)
  const fpol = await c.query<{ t: string; p: string; f: string }>(
    `select po.polrelid::regclass::text t, po.polname p, pr.proname f from pg_policy po join pg_depend d on d.objid = po.oid and d.classid = 'pg_policy'::regclass
     join pg_proc pr on pr.oid = d.refobjid where pr.pronamespace = 'public'::regnamespace and pr.proname = any($1::text[]) and po.polrelid::regclass::text <> all($2::text[])`, [[...CARE_FUNCTIONS], tables])
  for (const r of fpol.rows) out.push(`policy ${r.p} on ${r.t} uses ${r.f}`)
  return out
}

async function appRoles(c: Conn): Promise<string[]> {
  return (await c.query<{ rolname: string }>("select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1")).rows.map(r => r.rolname)
}

export async function report(url: string) {
  const c = await connect(url)
  try {
    const present = await presentTables(c)
    const fns = await presentFunctions(c)
    const counts = await countRows(c, 'public', present)
    const missing = CARE_TABLES.filter(t => !present.includes(t))
    const bl = await blockers(c, present)
    console.log(`care tables on this database: ${present.length} of ${CARE_TABLES.length} (${missing.length} do not exist here)`)
    console.table(present.map(t => ({ table: t, rows: counts[t] })))
    console.log(`total rows: ${Object.values(counts).reduce((a, b) => a + b, 0)}; tables with rows: ${present.filter(t => counts[t] > 0).length}`)
    console.log(`consulting functions to archive: ${fns.length ? fns.map(f => f.name).join(', ') : 'none present'}`)
    console.log(`not archived (still used): ${KEEP_TABLES.join(', ')}`)
    console.log(bl.length ? `BLOCKERS:\n  - ${bl.join('\n  - ')}` : 'blockers: none (nothing we keep depends on these tables or functions)')
    return { present, counts, functions: fns.map(f => f.name), blockers: bl }
  } finally { await c.end() }
}

export async function dump(url: string, out: string) {
  if (httpRef(url)) return dumpJson(url, out)
  const c = await connect(url)
  let present: string[], counts: Record<string, number>
  try { present = await presentTables(c); counts = await countRows(c, 'public', present) } finally { await c.end() }
  if (!present.length) throw new Error('no care tables on this database: nothing to dump')
  const args = ['-Fc', '--no-owner', '--no-privileges', '--file', out, ...present.flatMap(t => ['-t', `public.${t}`]), url]
  execFileSync('pg_dump', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  const sha = createHash('sha256').update(readFileSync(out)).digest('hex')
  writeFileSync(`${out}.counts.tsv`, present.map(t => `${t}\t${counts[t]}`).join('\n') + '\n')
  writeFileSync(`${out}.sha256`, `${sha}  ${out}\n`)
  console.log(`dump: ${out}\n  size: ${statSync(out).size} bytes\n  sha256: ${sha}\n  manifest: ${out}.counts.tsv (${present.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows)`)
  return { sha, counts }
}

/** HTTPS: every care table's rows as JSON ({ table: rows[] }), with the same manifest and sha256 as a pg_dump. */
async function dumpJson(url: string, out: string) {
  const c = await connect(url)
  const present = await presentTables(c), counts = await countRows(c, 'public', present)
  if (!present.length) throw new Error('no care tables on this database: nothing to dump')
  const data: Record<string, unknown[]> = {}
  for (const t of present) data[t] = (await c.query<{ rows: unknown[] }>(`select coalesce(json_agg(x), '[]'::json) as rows from public.${q(t)} x`)).rows[0].rows
  for (const t of present) if (data[t].length !== counts[t]) throw new Error(`${t}: counted ${counts[t]} rows but exported ${data[t].length}`)
  writeFileSync(out, JSON.stringify(data))
  const sha = createHash('sha256').update(readFileSync(out)).digest('hex')
  writeFileSync(`${out}.counts.tsv`, present.map(t => `${t}\t${counts[t]}`).join('\n') + '\n')
  writeFileSync(`${out}.sha256`, `${sha}  ${out}\n`)
  console.log(`dump (JSON): ${out}\n  size: ${statSync(out).size} bytes\n  sha256: ${sha}\n  manifest: ${out}.counts.tsv (${present.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows)`)
  return { sha, counts }
}

function readManifest(dumpFile: string): Record<string, number> {
  if (!existsSync(dumpFile) || !existsSync(`${dumpFile}.counts.tsv`) || !existsSync(`${dumpFile}.sha256`)) throw new Error(`dump, ${dumpFile}.counts.tsv and ${dumpFile}.sha256 must all exist`)
  const sha = createHash('sha256').update(readFileSync(dumpFile)).digest('hex')
  if (!readFileSync(`${dumpFile}.sha256`, 'utf8').startsWith(sha)) throw new Error('the dump file does not match its recorded sha256')
  const m: Record<string, number> = {}
  for (const line of readFileSync(`${dumpFile}.counts.tsv`, 'utf8').split('\n').filter(Boolean)) { const [t, n] = line.split('\t'); m[t] = Number(n) }
  return m
}

export async function apply(url: string, dumpFile: string) {
  if (httpRef(url)) return applyHttp(url, dumpFile)
  const manifest = readManifest(dumpFile)
  const sha = readFileSync(`${dumpFile}.sha256`, 'utf8').split(/\s+/)[0]
  const c = await connect(url)
  try {
    const hasLog = (await c.query('select to_regclass($1) is not null as x', [`${SCHEMA}._archive_log`])).rows[0].x
    const present = await presentTables(c)
    const fns = await presentFunctions(c)
    if (!present.length && !fns.length) { console.log(hasLog ? 'nothing to do: the care tables are already archived' : 'nothing to do: no care tables or functions on this database'); return }
    const bl = await blockers(c, present)
    if (bl.length) throw new Error(`refusing: something we keep depends on the care tables or functions:\n  - ${bl.join('\n  - ')}`)
    const roles = await appRoles(c)
    await c.query('begin')
    try {
      const counts = await countRows(c, 'public', present)
      for (const t of present) if (manifest[t] !== counts[t]) throw new Error(`the data changed since the dump (${t}: dump ${manifest[t]}, now ${counts[t]}). Make a new dump.`)
      for (const t of Object.keys(manifest)) if (!present.includes(t)) throw new Error(`${t} is in the dump but missing now. Make a new dump.`)
      await c.query(`create schema if not exists ${SCHEMA}`)
      await c.query(`create table if not exists ${SCHEMA}._archive_log (table_name text primary key, rows_at_archive bigint not null, archived_at timestamptz not null default now(), dump_sha256 text not null)`)
      await c.query(`create table if not exists ${SCHEMA}._archive_grants (table_name text not null, grantee text not null, privilege text not null, primary key (table_name, grantee, privilege))`)
      await c.query(`create table if not exists ${SCHEMA}._archive_functions (name text not null, args text not null, public_execute boolean not null, grantees text[] not null default '{}', archived_at timestamptz not null default now(), primary key (name, args))`)
      for (const t of present) {
        await c.query(`insert into ${SCHEMA}._archive_grants (table_name, grantee, privilege) select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee = any($2::text[]) on conflict do nothing`, [t, roles])
        await c.query(`alter table public.${q(t)} set schema ${SCHEMA}`)
        await c.query(`insert into ${SCHEMA}._archive_log (table_name, rows_at_archive, dump_sha256) values ($1, $2, $3)`, [t, counts[t], sha])
      }
      for (const f of fns) {
        const acl = (await c.query<{ pub: boolean; grantees: string[] }>(
          `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) pub,
                  coalesce(array_agg(distinct r.rolname) filter (where a.grantee <> 0 and a.privilege_type = 'EXECUTE' and r.rolname = any($2::text[])), '{}') grantees
           from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee where p.oid = $1::oid`, [f.oid, roles])).rows[0]
        await c.query(`insert into ${SCHEMA}._archive_functions (name, args, public_execute, grantees) values ($1, $2, $3, $4)`, [f.name, f.args, acl.pub, acl.grantees])
        await c.query(`alter function ${sig('public', f)} set schema ${SCHEMA}`)
        await c.query(`revoke all on function ${sig(SCHEMA, f)} from public`)
        for (const r of roles) await c.query(`revoke all on function ${sig(SCHEMA, f)} from ${q(r)}`)
      }
      await c.query(`revoke all on schema ${SCHEMA} from public`)
      await c.query(`revoke all on all tables in schema ${SCHEMA} from public`)
      for (const r of roles) {
        await c.query(`revoke all on schema ${SCHEMA} from ${q(r)}`)
        await c.query(`revoke all on all tables in schema ${SCHEMA} from ${q(r)}`)
        await c.query(`revoke all on all sequences in schema ${SCHEMA} from ${q(r)}`)
      }
      const after = await countRows(c, SCHEMA, present)
      for (const t of present) if (after[t] !== counts[t]) throw new Error(`row count mismatch after the move (${t}: ${counts[t]} -> ${after[t]})`)
      const left = await presentTables(c), leftFns = await presentFunctions(c)
      if (left.length || leftFns.length) throw new Error(`still in public: ${[...left, ...leftFns.map(f => `${f.name}()`)].join(', ')}`)
      await c.query('commit')
      console.log(`archived ${present.length} tables (${Object.values(counts).reduce((a, b) => a + b, 0)} rows) and ${fns.length} functions into schema ${SCHEMA}; app roles (${roles.join(', ') || 'none'}) revoked; dump sha256 ${sha}`)
    } catch (e) { await c.query('rollback'); throw e }
  } finally { await c.end() }
}

/** One request: begin; assert counts; move, log, revoke; assert counts and an empty public; commit. */
async function applyHttp(url: string, dumpFile: string) {
  const manifest = readManifest(dumpFile)
  const sha = readFileSync(`${dumpFile}.sha256`, 'utf8').split(/\s+/)[0]
  const c = await connect(url)
  const present = await presentTables(c), fns = await presentFunctions(c)
  if (!present.length && !fns.length) { console.log('nothing to do: no care tables or functions in public'); return }
  const bl = await blockers(c, present)
  if (bl.length) throw new Error(`refusing: something we keep depends on the care tables or functions:\n  - ${bl.join('\n  - ')}`)
  const roles = await appRoles(c)
  const counts = await countRows(c, 'public', present)
  for (const t of present) if (manifest[t] !== counts[t]) throw new Error(`the data changed since the dump (${t}: dump ${manifest[t]}, now ${counts[t]}). Make a new dump.`)
  for (const t of Object.keys(manifest)) if (!present.includes(t)) throw new Error(`${t} is in the dump but missing now. Make a new dump.`)
  const acls: { f: Fn; pub: boolean; grantees: string[] }[] = []
  for (const f of fns) {
    const a = (await c.query<{ pub: boolean; grantees: string[] }>(
      `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) pub,
              coalesce(array_agg(distinct r.rolname) filter (where a.grantee <> 0 and a.privilege_type = 'EXECUTE' and r.rolname = any($2::text[])), '{}') grantees
       from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee where p.oid = $1::oid`, [f.oid, roles])).rows[0]
    acls.push({ f, pub: a.pub, grantees: a.grantees })
  }
  const L = (v: unknown) => literal(v)
  const assertCounts = (schema: string, when: string) => `do $$ begin\n${present.map(t =>
    `  if (select count(*) from ${q(schema)}.${q(t)}) <> ${counts[t]} then raise exception 'row count mismatch ${when} (${t}: expected ${counts[t]})'; end if;`).join('\n')}\nend $$;`
  const sql = [
    'begin;',
    assertCounts('public', 'before the move: the data changed since the dump'),
    `create schema if not exists ${SCHEMA};`,
    `create table if not exists ${SCHEMA}._archive_log (table_name text primary key, rows_at_archive bigint not null, archived_at timestamptz not null default now(), dump_sha256 text not null);`,
    `create table if not exists ${SCHEMA}._archive_grants (table_name text not null, grantee text not null, privilege text not null, primary key (table_name, grantee, privilege));`,
    `create table if not exists ${SCHEMA}._archive_functions (name text not null, args text not null, public_execute boolean not null, grantees text[] not null default '{}', archived_at timestamptz not null default now(), primary key (name, args));`,
    ...present.flatMap(t => [
      `insert into ${SCHEMA}._archive_grants (table_name, grantee, privilege) select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = ${L(t)} and grantee = any(${L(roles)}) on conflict do nothing;`,
      `alter table public.${q(t)} set schema ${SCHEMA};`,
      `insert into ${SCHEMA}._archive_log (table_name, rows_at_archive, dump_sha256) values (${L(t)}, ${counts[t]}, ${L(sha)});`,
    ]),
    ...acls.flatMap(({ f, pub, grantees }) => [
      `insert into ${SCHEMA}._archive_functions (name, args, public_execute, grantees) values (${L(f.name)}, ${L(f.args)}, ${L(pub)}, ${L(grantees)});`,
      `alter function ${sig('public', f)} set schema ${SCHEMA};`,
      `revoke all on function ${sig(SCHEMA, f)} from public;`,
      ...roles.map(r => `revoke all on function ${sig(SCHEMA, f)} from ${q(r)};`),
    ]),
    `revoke all on schema ${SCHEMA} from public;`, `revoke all on all tables in schema ${SCHEMA} from public;`,
    ...roles.flatMap(r => [`revoke all on schema ${SCHEMA} from ${q(r)};`, `revoke all on all tables in schema ${SCHEMA} from ${q(r)};`, `revoke all on all sequences in schema ${SCHEMA} from ${q(r)};`]),
    assertCounts(SCHEMA, 'after the move'),
    `do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = any(${L([...CARE_TABLES])})) then raise exception 'care tables still in public'; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = any(${L([...CARE_FUNCTIONS])})) then raise exception 'consulting functions still in public'; end if;
end $$;`,
    'commit;',
  ].join('\n')
  try { await c.query(sql) } catch (e) { await c.query('rollback').catch(() => {}); throw e }
  console.log(`archived ${present.length} tables (${Object.values(counts).reduce((a, b) => a + b, 0)} rows) and ${fns.length} functions into schema ${SCHEMA}; app roles (${roles.join(', ') || 'none'}) revoked; dump sha256 ${sha}`)
}

export async function verify(url: string) {
  const c = await connect(url)
  try {
    const log = (await c.query<{ table_name: string; rows_at_archive: string }>(`select table_name, rows_at_archive::text from ${SCHEMA}._archive_log order by 1`)).rows
    const fns = (await c.query<{ name: string; args: string }>(`select name, args from ${SCHEMA}._archive_functions order by 1, 2`)).rows
    if (!log.length && !fns.length) throw new Error('nothing archived')
    const roles = await appRoles(c)
    const counts = await countRows(c, SCHEMA, log.map(r => r.table_name))
    const problems: string[] = []
    for (const r of log) {
      if (counts[r.table_name] !== Number(r.rows_at_archive)) problems.push(`${r.table_name}: ${r.rows_at_archive} at archive, ${counts[r.table_name]} now`)
      for (const role of roles) {
        const sel = (await c.query<{ x: boolean }>('select has_table_privilege($1, $2, $3) as x', [role, `${SCHEMA}.${q(r.table_name)}`, 'select'])).rows[0].x
        const ins = (await c.query<{ x: boolean }>('select has_table_privilege($1, $2, $3) as x', [role, `${SCHEMA}.${q(r.table_name)}`, 'insert'])).rows[0].x
        if (sel || ins) problems.push(`${role} can still reach ${r.table_name}`)
      }
    }
    for (const f of fns) for (const role of roles) {
      const x = (await c.query<{ x: boolean | null }>(
        `select has_function_privilege($1, p.oid, 'execute') as x from pg_proc p where p.pronamespace = $2::regnamespace and p.proname = $3 and pg_get_function_identity_arguments(p.oid) = $4`, [role, SCHEMA, f.name, f.args])).rows[0]?.x
      if (x === undefined) problems.push(`${f.name}() is not in schema ${SCHEMA}`)
      else if (x) problems.push(`${role} can still run ${f.name}()`)
    }
    for (const role of roles) if ((await c.query<{ x: boolean }>('select has_schema_privilege($1, $2, $3) as x', [role, SCHEMA, 'usage'])).rows[0].x) problems.push(`${role} has USAGE on schema ${SCHEMA}`)
    const stray = await presentTables(c), strayFns = await presentFunctions(c)
    if (stray.length || strayFns.length) problems.push(`still in public: ${[...stray, ...strayFns.map(f => `${f.name}()`)].join(', ')}`)
    if (problems.length) throw new Error(`verify failed:\n  - ${problems.join('\n  - ')}`)
    console.log(`verify ok: ${log.length} tables (${log.reduce((a, r) => a + Number(r.rows_at_archive), 0)} rows, counts match) and ${fns.length} functions archived; ${roles.join('/')} have no access`)
  } finally { await c.end() }
}

export async function restore(url: string) {
  if (httpRef(url)) return restoreHttp(url)
  const c = await connect(url)
  try {
    const log = (await c.query<{ table_name: string }>(`select table_name from ${SCHEMA}._archive_log order by 1`)).rows.map(r => r.table_name)
    const fns = (await c.query<{ name: string; args: string; public_execute: boolean; grantees: string[] }>(`select name, args, public_execute, grantees from ${SCHEMA}._archive_functions order by 1, 2`)).rows
    if (!log.length && !fns.length) throw new Error('nothing archived')
    await c.query('begin')
    try {
      for (const t of log) await c.query(`alter table ${SCHEMA}.${q(t)} set schema public`)
      const grants = (await c.query<{ table_name: string; grantee: string; privilege: string }>(`select table_name, grantee, privilege from ${SCHEMA}._archive_grants`)).rows
      for (const g of grants) await c.query(`grant ${g.privilege} on public.${q(g.table_name)} to ${q(g.grantee)}`)
      for (const f of fns) {
        await c.query(`alter function ${sig(SCHEMA, f)} set schema public`)
        if (f.public_execute) await c.query(`grant execute on function ${sig('public', f)} to public`)
        else await c.query(`revoke all on function ${sig('public', f)} from public`)
        for (const g of f.grantees) await c.query(`grant execute on function ${sig('public', f)} to ${q(g)}`)
      }
      await c.query(`drop table ${SCHEMA}._archive_functions`)
      await c.query(`drop table ${SCHEMA}._archive_log`)
      await c.query(`drop table ${SCHEMA}._archive_grants`)
      await c.query(`drop schema ${SCHEMA}`) // fails (rolls back) if anything else is in it
      await c.query('commit')
      console.log(`restored ${log.length} tables (${grants.length} grants) and ${fns.length} functions to public`)
    } catch (e) { await c.query('rollback'); throw e }
  } finally { await c.end() }
}

async function restoreHttp(url: string) {
  const c = await connect(url)
  const log = (await c.query<{ table_name: string }>(`select table_name from ${SCHEMA}._archive_log order by 1`)).rows.map(r => r.table_name)
  const fns = (await c.query<{ name: string; args: string; public_execute: boolean; grantees: string[] }>(`select name, args, public_execute, grantees from ${SCHEMA}._archive_functions order by 1, 2`)).rows
  if (!log.length && !fns.length) throw new Error('nothing archived')
  const grants = (await c.query<{ table_name: string; grantee: string; privilege: string }>(`select table_name, grantee, privilege from ${SCHEMA}._archive_grants`)).rows
  const sql = ['begin;',
    ...log.map(t => `alter table ${SCHEMA}.${q(t)} set schema public;`),
    ...grants.map(g => `grant ${g.privilege} on public.${q(g.table_name)} to ${q(g.grantee)};`),
    ...fns.flatMap(f => [`alter function ${sig(SCHEMA, f)} set schema public;`,
      f.public_execute ? `grant execute on function ${sig('public', f)} to public;` : `revoke all on function ${sig('public', f)} from public;`,
      ...f.grantees.map(g => `grant execute on function ${sig('public', f)} to ${q(g)};`)]),
    `drop table ${SCHEMA}._archive_functions;`, `drop table ${SCHEMA}._archive_log;`, `drop table ${SCHEMA}._archive_grants;`,
    `drop schema ${SCHEMA};`, 'commit;'].join('\n')
  try { await c.query(sql) } catch (e) { await c.query('rollback').catch(() => {}); throw e }
  console.log(`restored ${log.length} tables (${grants.length} grants) and ${fns.length} functions to public`)
}

export async function dropArchive(url: string, confirm: boolean) {
  if (!confirm) throw new Error('refusing: pass --confirm-drop to delete the archive')
  const c = await connect(url)
  try {
    const age = (await c.query<{ days: string | null }>(`select (extract(epoch from now() - min(archived_at)) / 86400)::text as days from ${SCHEMA}._archive_log`)).rows[0].days
    if (age === null) throw new Error('nothing archived')
    if (Number(age) < MIN_AGE_DAYS) throw new Error(`refusing: archived ${Number(age).toFixed(1)} days ago; the archive is kept for ${MIN_AGE_DAYS} days`)
    await c.query(`drop schema ${SCHEMA} cascade`)
    console.log(`dropped schema ${SCHEMA} (archived ${Number(age).toFixed(0)} days ago)`)
  } finally { await c.end() }
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2)
  const ref = arg(argv, 'http')
  const url = ref ? `${HTTP}${ref}` : arg(argv, 'db')
  if (!cmd || !url) { console.error('usage: archive-care-tables.ts <report|dump|apply|verify|restore|drop> (--db <url> | --http <project-ref>) [...]'); process.exit(2) }
  if (ref) { if (arg(argv, 'confirm-production') !== ref) throw new Error(`refusing to touch Supabase project ${ref} without --confirm-production=${ref} (owner approval required)`) }
  else assertTargetAllowed(url, argv)
  if (cmd === 'report') await report(url)
  else if (cmd === 'dump') await dump(url, arg(argv, 'out') ?? (() => { throw new Error('--out <file> required') })())
  else if (cmd === 'apply') await apply(url, arg(argv, 'dump') ?? (() => { throw new Error('--dump <file> required') })())
  else if (cmd === 'verify') await verify(url)
  else if (cmd === 'restore') await restore(url)
  else if (cmd === 'drop') await dropArchive(url, argv.includes('--confirm-drop'))
  else throw new Error(`unknown command ${cmd}`)
}
if (process.argv[1] && /archive-care-tables\.ts$/.test(process.argv[1])) main().catch(e => { console.error(String(e.message ?? e)); process.exit(1) })
