/**
 * Organization deletion. Owner-initiated, with a cooling-off period (ORG_DELETION_COOLING_OFF_DAYS,
 * default 7, 1 to 30) during which the request can be cancelled; nothing is deleted before it ends.
 * Then the deletion job (platform.deletion on the queue, lib/platform/jobs.ts) runs these steps:
 *
 *   1. revoke provider access: every email account's tokens are revoked at the provider where it allows it
 *      (lib/email/accounts.ts revokeAtProvider); WooCommerce stores are disconnected (our webhooks removed
 *      from the store); HubSpot, Google Calendar and Shopify have no revoke call in Deploi, so their stored
 *      tokens are deleted with the data (the merchant removes the app on their side; Shopify's uninstall
 *      also ends billing there)
 *   2. cancel billing: the Stripe subscription is cancelled at once (lib/billing/checkout.ts)
 *   3. delete the organization's data: every row of every table that carries its org_id / agency_id,
 *      except the records the law or security requires us to keep (KEPT below; docs/DATA-RETENTION.md):
 *      legal acceptances, billing customers, subscriptions and events, the tamper-evident engine audit
 *      trail and the row-level audit log (ids only, no content), and this deletion request
 *   4. people: each member's sign-in account is deleted (auth.users, which removes the profile); where the
 *      database role may not delete it, the profile is anonymized and detached and the count is reported
 *   5. the organization row stays as an anonymized tombstone (name "Deleted organization", deleted_at set)
 *      so the kept records still point at something
 *   6. a final audit entry is written outside the deleted organization (engine_audit, global chain)
 * Steps 3 to 6 run in one transaction. A failure marks the request failed (with the reason) and the next
 * run retries; steps 1 and 2 are safe to repeat.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import { assertCan } from './rbac'
import { log } from '../log'

export const KEPT_TABLES = ['agencies', 'legal_acceptances', 'legal_documents', 'billing_customers', 'billing_subscriptions', 'billing_events', 'engine_audit', 'engine_audit_chain', 'audit_events', 'org_deletion_requests', 'profiles'] as const

export function coolingOffDays(e: Record<string, string | undefined> = process.env): number {
  const n = Number((e.ORG_DELETION_COOLING_OFF_DAYS ?? '').trim())
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 7
}

export type DeletionRequest = { id: string; org_id: string; requested_by: string; requested_at: string; execute_after: string; status: string; cancelled_by: string | null; cancelled_at: string | null; completed_at: string | null; attempts: number; result: Record<string, unknown>; error: string | null }
const SELECT = 'select id, org_id, requested_by, requested_at::text, execute_after::text, status, cancelled_by, cancelled_at::text, completed_at::text, attempts, result, error from org_deletion_requests'

function merchantOrg(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot delete a customer organization')
  return actor.orgId
}

/** The open (or most recent) request of the actor's organization. */
export async function deletionStatus(actor: Actor): Promise<{ request: DeletionRequest | null; coolingOffDays: number }> {
  const orgId = merchantOrg(actor)
  const request = await admin(db => db.one<DeletionRequest>(`${SELECT} where org_id = $1 order by requested_at desc limit 1`, [orgId]))
  return { request, coolingOffDays: coolingOffDays() }
}

/** Owner only. Starts the cooling-off period; a second request while one is open returns the open one. */
export async function requestDeletion(actor: Actor, opts: { now?: Date } = {}): Promise<DeletionRequest> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'org.delete')
  const now = opts.now ?? new Date()
  return admin(async db => {
    const open = await db.one<DeletionRequest>(`${SELECT} where org_id = $1 and status in ('pending','executing')`, [orgId])
    if (open) return open
    const after = new Date(now.getTime() + coolingOffDays() * 864e5)
    const row = (await db.one<DeletionRequest>(`insert into org_deletion_requests (org_id, requested_by, requested_at, execute_after) values ($1,$2,$3,$4) returning id`, [orgId, actor.label, now.toISOString(), after.toISOString()]))!
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'org.deletion_requested', actor: actor.label, detail: { request_id: row.id, execute_after: after.toISOString() } })
    return (await db.one<DeletionRequest>(`${SELECT} where id = $1`, [row.id]))!
  })
}

/** Owner only. Cancels a pending request (not one that is already executing). */
export async function cancelDeletion(actor: Actor): Promise<DeletionRequest> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'org.delete')
  return admin(async db => {
    const r = await db.one<{ id: string }>(`update org_deletion_requests set status = 'cancelled', cancelled_by = $2, cancelled_at = now() where org_id = $1 and status = 'pending' returning id`, [orgId, actor.label])
    if (!r) throw new EngineError('not_pending', 'there is no pending deletion to cancel (an executing deletion cannot be stopped)')
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'org.deletion_cancelled', actor: actor.label, detail: { request_id: r.id } })
    return (await db.one<DeletionRequest>(`${SELECT} where id = $1`, [r.id]))!
  })
}

export type RevokeOutcome = 'revoked' | 'disconnected' | 'not_supported' | 'failed'
/** Provider revocation per connector; tests replace them with fakes. */
export type Revokers = {
  email: (acc: { id: string; provider: string; org_id: string }) => Promise<RevokeOutcome>
  woocommerce: (conn: { id: string; org_id: string }) => Promise<RevokeOutcome>
  shopify: (conn: { id: string; org_id: string }) => Promise<RevokeOutcome>
  office: (conn: { id: string; org_id: string; provider: string }) => Promise<RevokeOutcome>
}

const ACTOR = 'system:deletion'

export const defaultRevokers: Revokers = {
  email: async acc => {
    const { revokeAtProvider } = await import('../email/accounts')
    return revokeAtProvider(acc as never)
  },
  woocommerce: async conn => {
    try {
      const { disconnectStore } = await import('../connectors/woocommerce/connect')
      await disconnectStore(conn.org_id, conn.id, ACTOR)
      return 'disconnected'
    } catch { return 'failed' }
  },
  // Shopify has no token revocation API: access ends when the merchant uninstalls the app; the token is deleted here
  shopify: async () => 'not_supported',
  // HubSpot and Google revoke on their side when the user removes the app; the tokens are deleted here
  office: async () => 'not_supported',
}

async function revokeAll(orgId: string, revokers: Revokers) {
  const { email, stores, office } = await admin(async db => ({
    email: await db.query<{ id: string; provider: string; org_id: string }>(`select id, provider, org_id from email_accounts where org_id = $1 and status <> 'disconnected'`, [orgId]),
    stores: await db.query<{ id: string; org_id: string; platform: string }>(`select id, org_id, platform from store_connections where org_id = $1 and status not in ('disconnected','uninstalled')`, [orgId]),
    office: await db.query<{ id: string; org_id: string; provider: string }>(`select id, org_id, provider from office_connections where org_id = $1 and status <> 'disconnected'`, [orgId]),
  }))
  const out: Record<string, Record<RevokeOutcome, number>> = {}
  const add = (k: string, o: RevokeOutcome) => { out[k] ??= { revoked: 0, disconnected: 0, not_supported: 0, failed: 0 }; out[k][o]++ }
  const safe = async (f: () => Promise<RevokeOutcome>): Promise<RevokeOutcome> => { try { return await f() } catch { return 'failed' } }
  for (const a of email) add('email', await safe(() => revokers.email(a)))
  for (const s of stores) {
    if (s.platform === 'woocommerce') add('woocommerce', await safe(() => revokers.woocommerce(s)))
    else if (s.platform === 'shopify') add('shopify', await safe(() => revokers.shopify(s)))
    else add(s.platform, 'not_supported')
  }
  for (const c of office) add(c.provider, await safe(() => revokers.office(c)))
  return out
}

/** Every public table with an organization column, except the kept ones. */
async function orgTables(db: Db): Promise<{ table: string; column: string }[]> {
  const rows = await db.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name in ('org_id', 'agency_id') order by c.table_name`)
  return rows.filter(r => !(KEPT_TABLES as readonly string[]).includes(r.table_name)).map(r => ({ table: r.table_name, column: r.column_name }))
}

/** Delete every org-scoped row (in the caller's transaction). Foreign keys decide the order: retried until nothing is left. */
export async function deleteOrgData(db: Db, orgId: string): Promise<{ rowsDeleted: number; tables: number }> {
  let pending = await orgTables(db)
  let rowsDeleted = 0, tables = 0
  for (let pass = 0; pass < 12 && pending.length; pass++) {
    const left: typeof pending = []
    let lastError = ''
    for (const t of pending) {
      await db.query('savepoint del')
      try {
        const r = await db.raw.query(`delete from ${JSON.stringify(t.table)} where ${JSON.stringify(t.column)} = $1`, [orgId])
        await db.query('release savepoint del')
        rowsDeleted += r.rowCount ?? 0
        if ((r.rowCount ?? 0) > 0) tables++
      } catch (e) {
        await db.query('rollback to savepoint del')
        left.push(t)
        lastError = `${t.table}: ${(e as Error).message.slice(0, 160)}`
      }
    }
    if (left.length === pending.length) throw new Error(`could not delete the organization's rows (${left.map(t => t.table).join(', ')}): ${lastError}`)
    pending = left
  }
  if (pending.length) throw new Error(`rows left in ${pending.map(t => t.table).join(', ')}`)
  return { rowsDeleted, tables }
}

async function removePeople(db: Db, orgId: string): Promise<{ accountsDeleted: number; profilesAnonymized: number }> {
  const people = await db.query<{ id: string }>(`select id from profiles where agency_id = $1 and role <> 'staff'`, [orgId])
  let accountsDeleted = 0, profilesAnonymized = 0
  for (const p of people) {
    await db.query('savepoint person')
    try {
      const r = await db.raw.query('delete from auth.users where id = $1', [p.id])
      await db.query('release savepoint person')
      if ((r.rowCount ?? 0) > 0) { accountsDeleted++; continue }
    } catch { await db.query('rollback to savepoint person') }
    await db.query(`update profiles set email = 'deleted-' || id::text || '@deleted.invalid', full_name = null, agency_id = null, org_role = null where id = $1`, [p.id])
    profilesAnonymized++
  }
  await db.query(`update profiles set agency_id = null, org_role = null where agency_id = $1`, [orgId]) // staff linked by mistake: detach only
  return { accountsDeleted, profilesAnonymized }
}

export type ExecuteOpts = { now?: Date; revokers?: Partial<Revokers>; fetchImpl?: typeof fetch }

/** Carry out one due request. Returns null when it is not due, not pending, or another worker holds it. */
export async function executeDeletion(requestId: string, opts: ExecuteOpts = {}) {
  const now = opts.now ?? new Date()
  const claimed = await admin(db => db.one<DeletionRequest>(
    `update org_deletion_requests set status = 'executing', started_at = coalesce(started_at, now()), attempts = attempts + 1, error = null
     where id = (select id from org_deletion_requests where id = $1 and execute_after <= $2 and (status in ('pending','failed') or (status = 'executing' and started_at < $2::timestamptz - interval '1 hour')) for update skip locked) returning id, org_id, status`, [requestId, now.toISOString()]))
  if (!claimed) return null
  const orgId = claimed.org_id
  const revokers: Revokers = { ...defaultRevokers, ...(opts.revokers ?? {}) }
  try {
    // stop every agent first so nothing new starts while access is revoked
    await admin(db => db.query(`insert into org_controls (org_id, agents_stopped, stop_reason, stopped_by, stopped_at) values ($1, true, 'the organization is being deleted', $2, now())
      on conflict (org_id) do update set agents_stopped = true, stop_reason = excluded.stop_reason, stopped_by = excluded.stopped_by, stopped_at = now()`, [orgId, ACTOR])).catch(() => {})
    const revoked = await revokeAll(orgId, revokers)
    const { cancelStripeSubscription } = await import('../billing/checkout')
    const billing = await admin(db => cancelStripeSubscription(db, orgId, { actor: ACTOR, reason: 'organization deleted', fetchImpl: opts.fetchImpl }))
    const result = await admin(async db => {
      const people = await removePeople(db, orgId)
      const data = await deleteOrgData(db, orgId)
      await db.query(`update agencies set name = 'Deleted organization', city = null, county = null, onboarding = '{}'::jsonb, retention = '{}'::jsonb, plan_key = null, members_can_approve = false, deleted_at = $2 where id = $1`, [orgId, now.toISOString()])
      const result = { revoked, billing, ...people, ...data, kept: KEPT_TABLES.filter(t => t !== 'profiles') }
      await db.query(`update org_deletion_requests set status = 'completed', completed_at = $2, result = $3 where id = $1`, [requestId, now.toISOString(), JSON.stringify(result)])
      // the final entry is outside the deleted organization: the global chain
      await audit(db, { orgId: null, entityType: 'org', entityId: orgId, event: 'org.deleted', actor: ACTOR, detail: { request_id: requestId, ...result } })
      return result
    })
    log.info('org.deleted', { request_id: requestId, rows: result.rowsDeleted })
    return { status: 'completed' as const, ...result }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500)
    await admin(db => db.query(`update org_deletion_requests set status = 'failed', error = $2 where id = $1`, [requestId, msg]))
    log.error('org.deletion_failed', { request_id: requestId, error: msg })
    return { status: 'failed' as const, error: msg }
  }
}

/** Every request whose cooling-off period has ended (failed ones are retried). */
export async function executeDueDeletions(opts: ExecuteOpts & { limit?: number } = {}) {
  const now = opts.now ?? new Date()
  const due = await admin(db => db.query<{ id: string }>(`select id from org_deletion_requests where status in ('pending','failed','executing') and execute_after <= $1 and attempts < 10 order by execute_after limit $2`, [now.toISOString(), opts.limit ?? 5]))
  const out = []
  for (const d of due) { const r = await executeDeletion(d.id, opts); if (r) out.push({ id: d.id, ...r }) }
  return out
}
