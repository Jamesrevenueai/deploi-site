/**
 * Health records written by the integration hub (tables connection_health and connection_health_state,
 * migration 055). This module is a leaf: the connect flows (Shopify install, WooCommerce connect, Office
 * OAuth, mailbox OAuth) call recordReconnected() without importing the registry.
 *
 * Every probe and every reconnection appends one connection_health row with previous_status -> status, so
 * operations alerting can act on transitions (rows where the two differ) without reading anything else.
 */
import type { Db } from '../db'
import { audit } from '../engine/audit'
import type { HealthStatus, IntegrationKey } from './types'

export type HealthStateRow = {
  org_id: string; integration: IntegrationKey; connection_id: string; status: HealthStatus; consecutive_failures: number; next_probe_at: string
  last_checked_at: string | null; last_success_at: string | null; last_error_code: string | null; last_error: string | null; last_error_at: string | null; updated_at: string
}

export type HealthRowInput = {
  orgId: string; integration: IntegrationKey; connectionId: string; trigger: 'schedule' | 'manual' | 'reconnect'
  ok: boolean; previous: HealthStatus | null; status: HealthStatus; code: string | null; message: string; latencyMs: number | null
  detail?: Record<string, string | number | boolean | null>; at?: Date
}

const clip = (s: string, n = 500) => s.replace(/\s+/g, ' ').trim().slice(0, n)
const codeOf = (c: string | null) => (c && /^[a-z][a-z0-9_]{0,40}$/.test(c) ? c : c ? 'error' : null)

/** Append one history row (in the caller's transaction). */
export async function insertHealthRow(db: Db, r: HealthRowInput) {
  await db.query(
    `insert into connection_health (org_id, integration, connection_id, trigger, ok, previous_status, status, code, message, latency_ms, detail, checked_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.orgId, r.integration, r.connectionId, r.trigger, r.ok, r.previous, r.status, codeOf(r.code), clip(r.message) || (r.ok ? 'ok' : 'failed'), r.latencyMs === null ? null : Math.max(0, Math.round(r.latencyMs)),
      JSON.stringify(r.detail ?? {}), (r.at ?? new Date()).toISOString()])
}

export async function loadHealthState(db: Db, integration: IntegrationKey, connectionId: string, lock = false): Promise<HealthStateRow | null> {
  return db.one<HealthStateRow>(`select * from connection_health_state where integration = $1 and connection_id = $2${lock ? ' for update' : ''}`, [integration, connectionId])
}

export async function saveHealthState(db: Db, s: { orgId: string; integration: IntegrationKey; connectionId: string; status: HealthStatus; failures: number; nextProbeAt: Date; checkedAt: Date; ok: boolean; code: string | null; message: string | null }) {
  await db.query(
    `insert into connection_health_state (org_id, integration, connection_id, status, consecutive_failures, next_probe_at, last_checked_at, last_success_at, last_error_code, last_error, last_error_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7, case when $8 then $7::timestamptz end, case when $8 then null else $9 end, case when $8 then null else $10 end, case when $8 then null else $7::timestamptz end, now())
     on conflict (integration, connection_id) do update set org_id = excluded.org_id, status = excluded.status, consecutive_failures = excluded.consecutive_failures, next_probe_at = excluded.next_probe_at,
       last_checked_at = excluded.last_checked_at,
       last_success_at = case when $8 then excluded.last_checked_at else connection_health_state.last_success_at end,
       last_error_code = case when $8 then connection_health_state.last_error_code else excluded.last_error_code end,
       last_error = case when $8 then connection_health_state.last_error else excluded.last_error end,
       last_error_at = case when $8 then connection_health_state.last_error_at else excluded.last_error_at end,
       updated_at = now()`,
    [s.orgId, s.integration, s.connectionId, s.status, s.failures, s.nextProbeAt.toISOString(), s.checkedAt.toISOString(), s.ok, codeOf(s.code), s.message ? clip(s.message) : null])
}

/** How long until the next scheduled probe after `failures` consecutive failures: 1 h, then 1, 2, 4, 8, 16 h, at most a day. */
export function nextProbeDelayMs(failures: number, baseMs = 3600e3, maxMs = 24 * 3600e3): number {
  if (failures <= 0) return baseMs
  return Math.min(maxMs, baseMs * 2 ** (failures - 1))
}

/**
 * A connection works again after the customer reconnected it (same id): the health state is reset, a
 * reconnect row records the transition, and Office agents that use it are due at once so their waiting work
 * resumes on the next scheduler pass (store agents become due again by themselves: the job queue only skips
 * them while their connection is not active). In the caller's transaction.
 */
export async function recordReconnected(db: Db, i: { orgId: string; integration: IntegrationKey; connectionId: string; actor: string; previous?: HealthStatus | null; now?: Date }) {
  const now = i.now ?? new Date()
  const state = await loadHealthState(db, i.integration, i.connectionId, true)
  const previous: HealthStatus | null = i.previous ?? state?.status ?? null
  await saveHealthState(db, { orgId: i.orgId, integration: i.integration, connectionId: i.connectionId, status: 'connected', failures: 0, nextProbeAt: new Date(now.getTime() + nextProbeDelayMs(0)), checkedAt: now, ok: true, code: null, message: null })
  await db.query(`update connection_health_state set last_error = null, last_error_code = null, last_error_at = null where integration = $1 and connection_id = $2`, [i.integration, i.connectionId])
  await insertHealthRow(db, { orgId: i.orgId, integration: i.integration, connectionId: i.connectionId, trigger: 'reconnect', ok: true, previous, status: 'connected', code: null, message: 'Reconnected: the connection works again.', latencyMs: null, at: now })
  let resumed = 0
  if (i.integration === 'hubspot' || i.integration === 'google_calendar' || i.integration === 'quickbooks' || i.integration === 'gmail' || i.integration === 'microsoft' || i.integration === 'agent_mailbox') {
    const r = await db.query<{ id: string }>(
      `update office_agents a set next_run_at = $3 from office_agent_policies p
       where p.id = a.active_policy_id and a.org_id = $1 and a.status = 'active' and (a.next_run_at is null or a.next_run_at > $3)
         and $2 in (p.policy->>'hubspotConnectionId', p.policy->>'calendarConnectionId', p.policy->>'quickbooksConnectionId', p.policy->>'mailboxAccountId')
       returning a.id`, [i.orgId, i.connectionId, now.toISOString()])
    resumed = r.length
  }
  await audit(db, { orgId: i.orgId, connectionId: i.integration === 'shopify' || i.integration === 'woocommerce' ? i.connectionId : null, entityType: 'connection', entityId: i.connectionId, event: 'connection.health_restored', actor: i.actor,
    detail: { integration: i.integration, previous_status: previous, office_agents_resumed: resumed } })
  return { previous, resumed }
}

/** Called by the connect flows after a connection row was re-authorized in place: records a restoration when it was broken (by its row or its health). */
export async function restoredIfBroken(db: Db, i: { orgId: string; integration: IntegrationKey; connectionId: string; actor: string; rowBroken: boolean; previous?: HealthStatus | null }) {
  const st = await loadHealthState(db, i.integration, i.connectionId)
  if (!i.rowBroken && (!st || st.status === 'connected')) return null
  return recordReconnected(db, { ...i, previous: i.previous ?? (i.rowBroken ? 'needs_reauth' : st?.status ?? null) })
}
