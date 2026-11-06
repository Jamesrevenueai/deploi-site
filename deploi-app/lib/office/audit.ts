/** Office events go to the same append-only engine audit trail (secrets scrubbed by key name). */
import type { Db } from '../db'
import { audit, type AuditEntry } from '../engine/audit'

export type OfficeEntity = 'office_connection' | 'office_credential' | 'office_agent' | 'office_policy' | 'office_action' | 'office_run' | 'office_lead' | 'office_meeting' | 'office_invoice'

export async function officeAudit(db: Db, a: { orgId: string; entityType: OfficeEntity; entityId?: string | null; event: string; actor: string; detail?: Record<string, unknown> }) {
  await audit(db, { ...a, entityType: a.entityType as unknown as AuditEntry['entityType'], event: a.event.startsWith('office.') ? a.event : `office.${a.event}`, detail: { office: true, ...(a.detail ?? {}) } })
}
