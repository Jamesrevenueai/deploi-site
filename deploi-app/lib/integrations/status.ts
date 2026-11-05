/** Connection status from the connection row and its health state (pure; shared by the registry, the probes and the job). */
import type { HealthStateRow } from './events'
import type { ConnRef } from './probes'
import type { ConnectionView, HealthStatus } from './types'

/** The connection row's own status, before health history. */
export function rowStatus(c: ConnRef): { status: HealthStatus; reason: string | null } {
  const reason = c.reason ? c.reason.replace(/^needs_reauth:\s*/, '') : null
  if (c.rawStatus === 'needs_reauth') return { status: 'needs_reauth', reason: reason ?? 'the provider no longer accepts this connection' }
  if (c.rawStatus === 'error') return /^needs_reauth/.test(c.reason ?? '') ? { status: 'needs_reauth', reason } : { status: 'error', reason }
  if (c.rawStatus === 'pending') return { status: 'error', reason: 'the installation did not finish' }
  return { status: 'connected', reason: null }
}

/** Row status combined with the health state: the row decides needs_reauth; the probes add needs_reauth and error. */
export function connectionStatus(c: ConnRef, s: HealthStateRow | null): ConnectionView {
  const own = rowStatus(c)
  let status = own.status, reason = own.reason
  if (status === 'connected' && s && (s.status === 'needs_reauth' || s.status === 'error')) { status = s.status; reason = s.last_error }
  return {
    id: c.id, label: c.label, status, reason, synthetic: c.synthetic,
    lastCheckedAt: s?.last_checked_at ?? null, lastSuccessAt: s?.last_success_at ?? null, nextCheckAt: s?.next_probe_at ?? null, consecutiveFailures: s?.consecutive_failures ?? 0,
    lastError: s?.last_error ? { code: s.last_error_code, message: s.last_error, at: s.last_error_at } : null,
  }
}
