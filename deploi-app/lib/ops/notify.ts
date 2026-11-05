/**
 * Where alert notices go. Alerts (lib/ops/alerts.ts) speak only to this small interface; the system mailer
 * (lib/email/system.ts) is wired to it at integration by `setOpsNotifier`. Until then the default notifier
 * writes one structured log line per notice and reports that nothing was sent, which the alert records.
 *
 * Recipients:
 *   staff   every address in STAFF_EMAILS, for every alert
 *   owner   the organization's owners (profiles.org_role = 'owner'), for alerts about their organization only;
 *           they get the customer-facing text (no internal detail, no other organization)
 * A notice never carries tenant data to anyone outside that tenant: staff notices name the organization by id.
 */
import type { Db } from '../db'
import { env } from '../env'
import { log } from '../log'

export type OpsNotice = {
  audience: 'staff' | 'owner'
  to: string[]
  subject: string
  text: string
  alertId: string
  /** opened: a new alert; resolved: its condition cleared */
  event: 'opened' | 'resolved'
}
export type NotifyResult = { ok: boolean; reason?: string }
export interface OpsNotifier { send(n: OpsNotice): Promise<NotifyResult> }

/** The default: log only. Honest about it: `ok: false` with the reason, so the alert shows nobody was emailed. */
export const logNotifier: OpsNotifier = {
  async send(n) {
    log.info('ops.alert_notice', { audience: n.audience, alert_id: n.alertId, event: n.event, recipients_count: n.to.length })
    return { ok: false, reason: 'no system mailer is wired to alerts in this environment (logged only)' }
  },
}

let current: OpsNotifier = logNotifier
/** Integration: wire the system mailer. Tests: install a recording fake. */
export function setOpsNotifier(n: OpsNotifier | null) { current = n ?? logNotifier }
export const opsNotifier = () => current

/** A fake that records every notice (tests; also a dry run for the console). */
export function recordingNotifier(result: NotifyResult = { ok: true }): OpsNotifier & { sent: OpsNotice[] } {
  const sent: OpsNotice[] = []
  return { sent, async send(n) { sent.push(n); return result } }
}

export function staffRecipients(e: { staffEmails: string[] } = env): string[] {
  return [...new Set(e.staffEmails)].filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
}

export async function ownerRecipients(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.query<{ email: string }>(`select lower(email) as email from profiles where agency_id = $1 and org_role = 'owner' and email is not null order by email limit 10`, [orgId])
  return rows.map(r => r.email)
}
