/**
 * Data layer. One Postgres pool, two ways in:
 *  - withUser(session, fn): runs fn inside a transaction AS THAT USER. Row-level
 *    security is enforced by Postgres exactly as on Supabase (request.jwt.claims
 *    + role authenticated). This is the only way pages and actions should query.
 *  - admin(fn): service role (bypasses RLS). Workers, seeds, auth bootstrap only.
 * Reads of client-side data are audited via auditRead().
 */
import { Pool, type PoolClient } from 'pg'
import { env } from './env'
import type { Session } from './session'
import { log } from './log'

export type Db = {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>
  one: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T | null>
  /** write an audit row for a read of client-side data */
  auditRead: (table: string, agencyId: string | null, rowIds?: string[]) => Promise<void>
  raw: PoolClient
}

let pool: Pool | null = null
export function getPool() {
  if (!pool) {
    if (!env.databaseUrl) throw new Error('DATABASE_URL is not set')
    pool = new Pool({ connectionString: env.databaseUrl, max: 8, ssl: env.databaseUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined })
  }
  return pool
}

function wrap(client: PoolClient): Db {
  return {
    raw: client,
    async query<T>(text: string, params: unknown[] = []) {
      const r = await client.query(text, params)
      return r.rows as T[]
    },
    async one<T>(text: string, params: unknown[] = []) {
      const r = await client.query(text, params)
      return (r.rows[0] as T) ?? null
    },
    async auditRead(table, agencyId, rowIds) {
      await client.query('select audit_read($1, $2, $3)', [table, agencyId, rowIds ?? null])
    },
  }
}

const TENANT_TABLES = new Set([
  'clients','aides','authorizations','shifts','shift_offers','visits','evv_exceptions',
  'referrals','applicants','proposed_actions','retention_checkins','assessments','trace_steps',
])
export const isTenantTable = (t: string) => TENANT_TABLES.has(t)

/** Run `fn` as the signed-in user with RLS enforced. */
export async function withUser<T>(session: Session, fn: (db: Db) => Promise<T>, opts: { ip?: string | null } = {}): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const claims = JSON.stringify({ sub: session.uid, role: 'authenticated', email: session.email })
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('app.ip', $2, true)", [claims, opts.ip ?? ''])
    await client.query('set local role authenticated')
    const out = await fn(wrap(client))
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    log.error('db.withUser failed', { error: (e as Error).message, uid: session.uid })
    throw e
  } finally {
    client.release()
  }
}

/**
 * Run `fn` for an organization whose user was authenticated by a platform (an embedded Shopify session
 * token verified on the server), with RLS enforced exactly like withUser. The org_id claim is set by the
 * server only; current_org_id() reads it. There is no profile row, so is_staff() is false.
 */
export async function withOrgSession<T>(orgId: string, actorLabel: string, fn: (db: Db) => Promise<T>, opts: { ip?: string | null } = {}): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('invalid org id')
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const claims = JSON.stringify({ role: 'authenticated', org_id: orgId, actor: actorLabel.slice(0, 120) })
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('app.ip', $2, true)", [claims, opts.ip ?? ''])
    await client.query('set local role authenticated')
    const out = await fn(wrap(client))
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Run `fn` with the service role (no RLS). Only for workers, seeds and auth bootstrap. */
export async function admin<T>(fn: (db: Db) => Promise<T>, opts: { actorId?: string | null; ip?: string | null } = {}): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const claims = JSON.stringify({ sub: opts.actorId ?? null, role: 'service_role' })
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('app.ip', $2, true)", [claims, opts.ip ?? ''])
    // On managed Postgres the connection role is a plain login role; service_role carries BYPASSRLS.
    await client.query('set local role service_role').catch(() => {})
    const out = await fn(wrap(client))
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Run `fn` as the anonymous role (public lead API). */
export async function anon<T>(fn: (db: Db) => Promise<T>, opts: { ip?: string | null } = {}): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('app.ip', $2, true)", [JSON.stringify({ role: 'anon' }), opts.ip ?? ''])
    await client.query('set local role anon')
    const out = await fn(wrap(client))
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
