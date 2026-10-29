import type { Db } from '../db'
import { log } from '../log'

export type AuditEntry = {
  orgId: string | null
  connectionId?: string | null
  entityType: 'connection' | 'credential' | 'rule' | 'scan' | 'issue' | 'proposal' | 'approval' | 'execution' | 'webhook' | 'subscription' | 'agent' | 'policy' | 'run' | 'reference' | 'access' | 'library'
  entityId?: string | null
  event: string
  actor: string
  detail?: Record<string, unknown>
}

const SECRET_KEY = /token|secret|password|authorization|cookie|ciphertext|access_key|refresh/i

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '[removed]' : scrub(x, depth + 1)
    return out
  }
  return v
}

/** Append one event to the engine audit trail (service role; the table is append-only). Secrets are scrubbed by key name. */
export async function audit(db: Db, a: AuditEntry): Promise<void> {
  await db.query(
    `insert into engine_audit (org_id, connection_id, entity_type, entity_id, event, actor, detail) values ($1,$2,$3,$4,$5,$6,$7)`,
    [a.orgId, a.connectionId ?? null, a.entityType, a.entityId ?? null, a.event, a.actor.slice(0, 160), JSON.stringify(scrub(a.detail ?? {}))])
  log.info('engine.' + a.event, { entity_type: a.entityType, entity_id: a.entityId ?? null, connection_id: a.connectionId ?? null })
}
