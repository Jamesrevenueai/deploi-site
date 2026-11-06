/**
 * Every table in `public` has row-level security enabled and a read policy scoped to the caller's
 * organization (or the caller's own row), or a staff-only policy, unless it is in the allowlist below
 * with the reason. A new table without RLS or without a scoped policy fails this test.
 */
import { describe, it, expect } from 'vitest'
import { prepareDb } from '../db/helpers'
import { withOwner, publicTables, orgColumn } from './pg'

const ready = await prepareDb()

/** Tables with RLS on and NO policy for user roles (deny-all): only the service role (server code) reads them. */
const DENY_ALL: Record<string, string> = {
  store_credentials: 'store access tokens (ciphertext); server only',
  email_credentials: 'mailbox OAuth tokens (ciphertext); server only',
  email_oauth_states: 'OAuth state/PKCE verifiers in flight; server only',
  synthetic_email_state: 'the fake mail provider used in demos and tests; server only',
  inbound_webhook_events: 'raw inbound webhook payloads before processing; server only',
  beta_invites: 'hashed beta invite codes; redeemed through server code only',
  _migrations: 'migration ledger (closed to user roles by migration 42, finding F-05)',
  woo_auth_states: 'WooCommerce authorization state and the key pair in flight (ciphertext); server only (migration 43)',
  woo_connections: 'WooCommerce site and webhook secret (ciphertext); server only (migration 43)',
  office_credentials: 'HubSpot / Google OAuth tokens (ciphertext); server only',
  office_oauth_states: 'Office OAuth state and PKCE verifiers in flight; server only',
  office_org_locks: 'per-organization scheduler lock; server only',
  office_synthetic_state: 'the fake HubSpot / Calendar providers used in demos and tests; server only',
  engine_audit_chain: 'head of each organization\'s audit hash chain; written by a definer trigger, verified by server code',
  rate_limits: 'request counters per bucket, key and window (IP or organization id); server only (migration 44, finding F-12)',
}
/** Tables readable by every signed-in user on purpose. */
const READ_ALL: Record<string, string> = {
  legal_documents: 'registry of legal document versions and fingerprints; holds no organization data',
}

const SCOPED = /(is_staff\(\)|current_org_id\(\)|current_agency_id\(\)|auth\.uid\(\))/

describe.skipIf(!ready)('RLS coverage of every public table', () => {
  it('every table has RLS enabled', async () => {
    const tables = await withOwner(publicTables)
    expect(tables.length).toBeGreaterThan(40)
    expect(tables.filter(t => !t.rls).map(t => t.table)).toEqual([])
  })

  it('every table has an org-scoped, self-scoped or staff-only read policy, or is allowlisted with a reason', async () => {
    const tables = await withOwner(publicTables)
    const bad: string[] = []
    for (const t of tables) {
      if (DENY_ALL[t.table]) { if (t.policies.length) bad.push(`${t.table}: allowlisted as deny-all but has policies ${t.policies.map(p => p.name).join(',')}`); continue }
      if (READ_ALL[t.table]) continue
      const read = t.policies.filter(p => p.cmd === 'r' || p.cmd === '*')
      if (!read.length) { bad.push(`${t.table}: no read policy`); continue }
      for (const p of read) if (!SCOPED.test(p.qual ?? '')) bad.push(`${t.table}.${p.name}: policy is not scoped (${(p.qual ?? '').slice(0, 80)})`)
    }
    expect(bad).toEqual([])
  })

  it('every write policy for user roles is staff-only or tenant-scoped (no open write policy)', async () => {
    const tables = await withOwner(publicTables)
    const bad: string[] = []
    for (const t of tables) for (const p of t.policies) {
      if (p.cmd === 'r') continue
      const expr = `${p.qual ?? ''} ${p.check ?? ''}`
      if (!SCOPED.test(expr)) bad.push(`${t.table}.${p.name} (${p.cmd})`)
    }
    expect(bad).toEqual([])
  })

  it('the allowlists only name tables that exist (stale entries are removed)', async () => {
    const names = new Set((await withOwner(publicTables)).map(t => t.table))
    for (const k of [...Object.keys(DENY_ALL), ...Object.keys(READ_ALL)]) expect(names.has(k), k).toBe(true)
  })

  it('every org-scoped engine table (org_id) also lets staff read for support, except where privacy keeps staff out', async () => {
    const STAFF_EXCLUDED: Record<string, string> = { library_chat_messages: 'merchant conversations with agents are private to the merchant' }
    const tables = await withOwner(publicTables)
    const missing = tables.filter(t => orgColumn(t) && !STAFF_EXCLUDED[t.table] && !t.policies.some(p => /is_staff\(\)/.test(p.qual ?? ''))).map(t => t.table)
    expect(missing).toEqual([])
  })

  it('no view in public bypasses RLS for user roles (security_invoker, or not granted to anon/authenticated)', async () => {
    const rows = await withOwner(c => c.query<{ relname: string; invoker: boolean; granted: boolean }>(
      `select c.relname, coalesce('security_invoker=true' = any(c.reloptions) or 'security_invoker=on' = any(c.reloptions), false) as invoker,
              has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select') as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('v','m')`))
    expect(rows.rows.filter(r => !r.invoker && r.granted).map(r => r.relname)).toEqual([])
  })
})
