/**
 * F-02 / F-01 / F-03 hotfix (supabase/migrations/20261031000001_signup_trust_hotfix.sql, lib/auth.ts).
 * Reproduces each attack against the real sign-up trigger and proves it no longer works.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDb, ORG_NW } from '../db/helpers'

const ready = await prepareDb()
const url = process.env.DATABASE_URL!
const ids: string[] = []

async function owner<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url }); await c.connect()
  try { return await fn(c) } finally { await c.end() }
}
/** Insert an auth user exactly as Supabase sign-up would, with metadata the person signing up chose. */
async function signUp(email: string, userMeta: Record<string, unknown>, appMeta: Record<string, unknown> = {}) {
  return owner(async c => {
    const r = await c.query<{ id: string }>(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values (gen_random_uuid(), $1, $2, $3) returning id`, [email, userMeta, appMeta])
    ids.push(r.rows[0].id)
    return (await c.query<{ role: string; agency_id: string | null }>('select role::text, agency_id from profiles where id = $1', [r.rows[0].id])).rows[0]
  })
}

describe.skipIf(!ready)('sign-up trust hotfix', () => {
  beforeAll(async () => {
    await owner(async c => {
      // Supabase's auth.users has raw_app_meta_data (server-set only); the local shim may not
      await c.query(`alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}'::jsonb`)
      await c.query(`insert into settings (key, value) values ('staff_emails', '["hello@getdeploi.com"]') on conflict (key) do update set value = excluded.value`)
    })
  })
  afterAll(async () => { await owner(async c => { await c.query('delete from profiles where id = any($1)', [ids]); await c.query('delete from auth.users where id = any($1)', [ids]) }) })

  it('the hotfix migration is applied and is idempotent', async () => {
    const sql = readFileSync(join(__dirname, '../../supabase/migrations/20261031000001_signup_trust_hotfix.sql'), 'utf8')
    await owner(async c => { await c.query(sql); await c.query(sql) })
    const def = await owner(c => c.query<{ d: string }>(`select pg_get_functiondef('public.handle_new_user'::regproc) as d`))
    expect(def.rows[0].d).not.toMatch(/-> 'raw_user_meta_data'/)
    expect(def.rows[0].d).toMatch(/-> 'raw_app_meta_data'/)
    expect(def.rows[0].d).not.toMatch(/position\(lower\(new\.email\) in staff_email_list/)
  })

  it('F-02: a person signing up cannot make themselves staff or join another organization', async () => {
    const p = await signUp(`attacker-${Date.now()}@evil.example`, { role: 'staff', agency_id: ORG_NW })
    expect(p).toEqual({ role: 'client', agency_id: null })
  })

  it('F-02: staff is an exact address match, not a substring', async () => {
    expect((await signUp(`hello@getdeploi.co`, {})).role).toBe('client') // a prefix of hello@getdeploi.com
    expect((await signUp(`xhello@getdeploi.com.evil.example`, {})).role).toBe('client')
  })

  it('server-set app metadata and invites still assign an organization', async () => {
    const viaApp = await signUp(`invited-app-${Date.now()}@client.example`, {}, { agency_id: ORG_NW, role: 'client' })
    expect(viaApp).toEqual({ role: 'client', agency_id: ORG_NW })
    const email = `invited-${Date.now()}@client.example`
    await owner(c => c.query(`insert into invites (email, agency_id, role, invited_by) select $1, $2, 'client', id from profiles where role = 'staff' limit 1`, [email, ORG_NW]).catch(() => c.query(`insert into invites (email, agency_id, role) values ($1, $2, 'client')`, [email, ORG_NW])))
    expect(await signUp(email, { role: 'staff' })).toEqual({ role: 'client', agency_id: ORG_NW })
  })

  it('F-01 and F-03: signed-in users cannot read the leads view; nobody but the definer can list staff addresses', async () => {
    const r = await owner(c => c.query<{ leads: boolean | null; anon_fn: boolean; auth_fn: boolean }>(`select
        case when to_regclass('public.leads') is null then null else has_table_privilege('authenticated', 'public.leads', 'select') end as leads,
        has_function_privilege('anon', 'public.staff_email_list()', 'execute') as anon_fn,
        has_function_privilege('authenticated', 'public.staff_email_list()', 'execute') as auth_fn`))
    expect(r.rows[0].leads === null || r.rows[0].leads === false).toBe(true)
    expect(r.rows[0]).toMatchObject({ anon_fn: false, auth_fn: false })
  })

  it('the app no longer builds a profile from user-editable metadata', () => {
    const src = readFileSync(join(__dirname, '../../lib/auth.ts'), 'utf8')
    expect(src).not.toMatch(/user_metadata \?\?/)
    expect(src).toMatch(/data\.user\.app_metadata \?\? \{\}/)
  })
})
