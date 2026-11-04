/**
 * Credentials, ciphertext and other secrets are unreadable by user roles; privileges that bypass RLS are
 * not granted; sign-up cannot choose a role or organization (findings F-01..F-05 of SECURITY-REVIEW-2026-11-04).
 */
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, ORG_HB } from '../db/helpers'
import { withUser } from '../../lib/db'
import { withOwner } from './pg'

const ready = await prepareDb()
const SECRET_COLUMN = /(cipher|secret|password|verifier|code_hash|reply_token|access_token|refresh_token|api_key)/i
/** Columns that match the pattern but are not secrets from their own organization. */
const NOT_SECRET: Record<string, string> = {
  'email_messages.reply_token': 'part of the Reply-To address every recipient sees; readable only by the owning organization (RLS)',
}
const CREDENTIAL_TABLES = ['store_credentials', 'email_credentials', 'email_oauth_states', 'woo_auth_states', 'woo_connections', 'office_credentials', 'office_oauth_states']

describe.skipIf(!ready)('credentials and privileges', () => {
  it('credential tables have no privilege for anon or authenticated, and a session reads nothing from them', async () => {
    const rows = await withOwner(c => c.query<{ t: string; anon: boolean; auth: boolean }>(
      `select t, has_table_privilege('anon', 'public.' || t, 'select') as anon, has_table_privilege('authenticated', 'public.' || t, 'select') as auth from unnest($1::text[]) t`, [CREDENTIAL_TABLES]))
    expect(rows.rows).toEqual(CREDENTIAL_TABLES.map(t => ({ t, anon: false, auth: false })))
    for (const t of CREDENTIAL_TABLES) {
      await expect(withUser(SESSIONS.northwind, db => db.query(`select * from ${t}`))).rejects.toThrow(/permission denied/)
      await expect(withUser(SESSIONS.staff, db => db.query(`select * from ${t}`))).rejects.toThrow(/permission denied/)
    }
  })

  it('no column holding ciphertext, a secret, a verifier or a code hash is selectable by a user role', async () => {
    const rows = await withOwner(c => c.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'
       and (has_column_privilege('authenticated', 'public.' || quote_ident(table_name), column_name, 'select') or has_column_privilege('anon', 'public.' || quote_ident(table_name), column_name, 'select'))`))
    const exposed = rows.rows.filter(r => SECRET_COLUMN.test(r.column_name)).map(r => `${r.table_name}.${r.column_name}`).filter(k => !NOT_SECRET[k])
    expect(exposed).toEqual([])
  })

  it('no public table grants TRUNCATE, TRIGGER or REFERENCES to anon or authenticated (TRUNCATE ignores RLS)', async () => {
    const rows = await withOwner(c => c.query<{ table_name: string; grantee: string; privilege_type: string }>(
      `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')`))
    expect(rows.rows).toEqual([])
  })

  it('the leads view no longer exposes early-access applications to signed-in users', async () => {
    await expect(withUser(SESSIONS.northwind, db => db.query('select * from leads'))).rejects.toThrow(/permission denied/)
    const opts = await withOwner(c => c.query<{ reloptions: string[] | null }>(`select reloptions from pg_class where relname = 'leads'`))
    expect(opts.rows[0]?.reloptions ?? []).toContain('security_invoker=true')
  })

  it('the staff e-mail list cannot be called by anon or authenticated', async () => {
    const r = await withOwner(c => c.query<{ anon: boolean; auth: boolean }>(`select has_function_privilege('anon', 'staff_email_list()', 'execute') as anon, has_function_privilege('authenticated', 'staff_email_list()', 'execute') as auth`))
    expect(r.rows[0]).toEqual({ anon: false, auth: false })
  })

  it('sign-up metadata cannot make a user staff or a member of another organization; staff is an exact e-mail match', async () => {
    await withOwner(async c => {
      await c.query('begin')
      try {
        await c.query(`select set_config('app.staff_emails', 'hello@getdeploi.com', true)`)
        const add = async (email: string, meta: Record<string, unknown>) => {
          const id = (await c.query<{ id: string }>(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`, [email, JSON.stringify(meta)])).rows[0].id
          return (await c.query<{ role: string; agency_id: string | null }>('select role::text, agency_id from profiles where id = $1', [id])).rows[0]
        }
        expect(await add('attacker@evil.example', { role: 'staff', agency_id: ORG_HB })).toEqual({ role: 'client', agency_id: null })
        expect(await add('hello@getdeploi.co', {})).toEqual({ role: 'client', agency_id: null })
        expect(await add('lo@getdeploi.com', {})).toEqual({ role: 'client', agency_id: null })
        expect((await add('Hello@GetDeploi.com', {})).role).toBe('staff')
      } finally { await c.query('rollback') }
    })
  })

  it('the app-side profile fallback reads server-set app_metadata, never user_metadata', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/auth.ts', 'utf8')
    expect(src).not.toMatch(/user\.user_metadata/)
    expect(src).toMatch(/user\.app_metadata/)
  })
})
