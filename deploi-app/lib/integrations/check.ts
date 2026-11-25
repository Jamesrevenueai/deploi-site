/**
 * One health check of one connection: run its read-only probe (with a timeout), then, in one transaction,
 * update its health state and append a connection_health row (previous_status -> status).
 *
 *   success                    connected; failures reset; next scheduled probe in an hour
 *   auth / forbidden / identity the provider no longer accepts the authorization: needs_reauth at once, and the
 *                              connection row is marked too (so agents stop and the customer sees Reconnect)
 *   anything else              one more consecutive failure; after three in a row the status flips to error.
 *                              The next scheduled probe backs off exponentially: 1, 2, 4, 8, 16 h, at most 24 h.
 * A successful probe of a WooCommerce store or a mailbox whose row said it needed reconnecting (the key or
 * grant works again) restores the row as well.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { loadConnection } from '../engine/scan'
import { markNeedsReauth } from '../connectors/shopify/client'
import { officeAudit } from '../office/audit'
import { markAccountAuthFailure } from '../email/accounts'
import { insertHealthRow, loadHealthState, nextProbeDelayMs, saveHealthState } from './events'
import { runProbe, type ConnRef } from './probes'
import { connectionStatus } from './status'
import type { HealthStatus, ProbeResult, TestOutcome } from './types'

export const healthConfig = {
  timeoutMs: 20_000,
  baseIntervalMs: 3600e3,
  maxIntervalMs: 24 * 3600e3,
  /** consecutive failures (other than authorization) before the status flips to error */
  flipAfter: 3,
}

const REAUTH = new Set(['auth', 'forbidden', 'identity_changed'])

/** Pure: the status after a probe. */
export function nextStatus(current: HealthStatus, r: Pick<ProbeResult, 'ok' | 'code'>, failures: number, flipAfter = healthConfig.flipAfter): HealthStatus {
  if (r.ok) return 'connected'
  if (r.code && REAUTH.has(r.code)) return 'needs_reauth'
  if (failures >= flipAfter) return 'error'
  return current === 'not_connected' || current === 'not_configured' ? 'connected' : current
}

/** Mark the connection row itself as needing a reconnection (only while it is active). */
async function markRow(db: Db, c: ConnRef, reason: string) {
  if (c.integration === 'shopify') {
    const conn = await loadConnection(db, c.id)
    if (conn && conn.status === 'active') await markNeedsReauth(db, conn, reason, 'system:connection-health')
  } else if (c.integration === 'woocommerce') {
    const r = await db.query(`update store_connections set status = 'error', status_reason = $2, reauth_required_at = now() where id = $1 and status = 'active' returning id`, [c.id, `needs_reauth: ${reason}`])
    if (r.length) await audit(db, { orgId: c.orgId, connectionId: c.id, entityType: 'connection', entityId: c.id, event: 'connection.needs_reauth', actor: 'system:connection-health', detail: { reason } })
  } else if (c.integration === 'hubspot' || c.integration === 'google_calendar' || c.integration === 'quickbooks') {
    const r = await db.query(`update office_connections set status = 'needs_reauth', status_reason = $2 where id = $1 and status = 'active' returning id`, [c.id, reason])
    if (r.length) await officeAudit(db, { orgId: c.orgId, entityType: 'office_connection', entityId: c.id, event: 'connection.needs_reauth', actor: 'system:connection-health', detail: { provider: c.integration, reason } })
  }
}

/** A probe succeeded although the row said it needed reconnecting: the key or grant works again. */
async function restoreRow(db: Db, c: ConnRef) {
  if (c.integration === 'woocommerce') {
    const r = await db.query(`update store_connections set status = 'active', status_reason = null, reauth_required_at = null where id = $1 and status = 'error' and status_reason like 'needs_reauth:%' returning id`, [c.id])
    if (r.length) await audit(db, { orgId: c.orgId, connectionId: c.id, entityType: 'connection', entityId: c.id, event: 'connection.reauthorized', actor: 'system:connection-health', detail: { reason: 'the store accepts the key again' } })
  } else if (c.integration === 'gmail' || c.integration === 'microsoft') {
    await db.query(`update email_accounts set status = 'active', status_reason = null, last_error_code = null, last_checked_at = now(), last_success_at = now() where id = $1 and status = 'needs_reauth' and can_send`, [c.id])
  }
}

export async function probeAndRecord(c: ConnRef, trigger: 'schedule' | 'manual', opts: { now?: Date; timeoutMs?: number } = {}): Promise<TestOutcome> {
  const r = await runProbe(c, opts.timeoutMs ?? healthConfig.timeoutMs)
  const now = opts.now ?? new Date()
  // the email row is marked in its own transaction (lib/email/accounts.ts)
  if (!r.ok && r.code && REAUTH.has(r.code) && (c.integration === 'gmail' || c.integration === 'microsoft')) await markAccountAuthFailure(c.id, r.message)
  const { previous, status } = await admin(async db => {
    const state = await loadHealthState(db, c.integration, c.id, true)
    const current = connectionStatus(c, state).status
    const failures = r.ok ? 0 : (state?.consecutive_failures ?? 0) + 1
    const next = nextStatus(current, r, failures)
    if (!r.ok && r.code && REAUTH.has(r.code)) await markRow(db, c, r.message)
    if (r.ok && current === 'needs_reauth') await restoreRow(db, c)
    const delay = nextProbeDelayMs(failures, healthConfig.baseIntervalMs, healthConfig.maxIntervalMs)
    await saveHealthState(db, { orgId: c.orgId, integration: c.integration, connectionId: c.id, status: next, failures, nextProbeAt: new Date(now.getTime() + delay), checkedAt: now, ok: r.ok, code: r.code, message: r.ok ? null : r.message })
    await insertHealthRow(db, { orgId: c.orgId, integration: c.integration, connectionId: c.id, trigger, ok: r.ok, previous: current, status: next, code: r.code, message: r.message, latencyMs: r.latencyMs, detail: r.detail, at: now })
    return { previous: current, status: next }
  })
  return { connectionId: c.id, label: c.label, ok: r.ok, previous, status, message: r.message, code: r.code, latencyMs: r.latencyMs }
}
