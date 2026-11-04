/**
 * The organization's audit trail for its owners: filtered reads under RLS, CSV export, and verification
 * of the tamper-evident hash chain (engine_audit.prev_hash / row_hash, linked at commit by a trigger).
 * Staff keep their read-only viewer (/staff/audit); the export and the chain check are per organization.
 */
import { admin } from '../db'
import { withActor, type Actor } from './actor'
import { EngineError } from './errors'

export type AuditFilters = { entityType?: string | null; event?: string | null; actor?: string | null; agentId?: string | null; entityId?: string | null; from?: string | null; to?: string | null; limit?: number; beforeId?: number | null }
export type AuditRow = { id: number; entity_type: string; entity_id: string | null; event: string; actor: string; detail: Record<string, unknown>; at: string; row_hash: string | null; chain_seq: number | null }

const TEXT = /^[\w.:@+-]{1,120}$/
const iso = (v: string | null | undefined) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString() }

export function parseAuditFilters(q: URLSearchParams): AuditFilters {
  const t = (k: string) => { const v = q.get(k)?.trim(); if (!v) return null; if (!TEXT.test(v)) throw new EngineError('invalid_input', `invalid ${k}`); return v }
  const agentId = q.get('agentId')?.trim() || null
  if (agentId && !/^[0-9a-f-]{36}$/i.test(agentId)) throw new EngineError('invalid_input', 'invalid agentId')
  const before = Number(q.get('beforeId') ?? '')
  return { entityType: t('entityType'), event: t('event'), actor: t('actor'), entityId: t('entityId'), agentId, from: iso(q.get('from')), to: iso(q.get('to')), limit: Number(q.get('limit') ?? 200) || 200, beforeId: Number.isFinite(before) && before > 0 ? before : null }
}

/** Newest first. `event` matches a prefix ("email." finds every email event). */
export async function searchAudit(actor: Actor, f: AuditFilters): Promise<AuditRow[]> {
  return withActor(actor, db => db.query<AuditRow>(
    `select id, entity_type, entity_id, event, actor, detail, at, row_hash, chain_seq from engine_audit
     where ${actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'}
       and ($1::text is null or entity_type = $1) and ($2::text is null or event like $2 || '%') and ($3::text is null or actor = $3)
       and ($4::text is null or detail->>'agent_id' = $4 or (entity_type = 'agent' and entity_id = $4)) and ($5::text is null or entity_id = $5)
       and ($6::timestamptz is null or at >= $6) and ($7::timestamptz is null or at < $7) and ($8::bigint is null or id < $8)
     order by at desc, id desc limit $9`,
    [f.entityType ?? null, f.event ?? null, f.actor ?? null, f.agentId ?? null, f.entityId ?? null, f.from ?? null, f.to ?? null, f.beforeId ?? null, Math.min(Math.max(f.limit ?? 200, 1), 5000)]))
}

const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  // spreadsheet formula injection: a leading = + - @ is neutralised
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function auditCsv(rows: AuditRow[]): string {
  const head = ['id', 'at', 'event', 'entity_type', 'entity_id', 'actor', 'detail', 'chain_seq', 'row_hash']
  return [head.join(','), ...rows.map(r => [r.id, new Date(r.at).toISOString(), r.event, r.entity_type, r.entity_id, r.actor, r.detail, r.chain_seq, r.row_hash].map(cell).join(','))].join('\r\n') + '\r\n'
}

export type ChainVerification = { ok: boolean; checked: number; brokenSeq: number | null; brokenId: number | null; reason: string | null }

/** Verify one organization's chain (service role; the caller has proved it belongs to the organization). */
export async function verifyAuditChain(orgId: string | null): Promise<ChainVerification> {
  const r = await admin(db => db.one<{ ok: boolean; checked: string; broken_seq: string | null; broken_id: string | null; reason: string | null }>('select * from verify_engine_audit_chain($1)', [orgId]))
  return { ok: Boolean(r?.ok), checked: Number(r?.checked ?? 0), brokenSeq: r?.broken_seq ? Number(r.broken_seq) : null, brokenId: r?.broken_id ? Number(r.broken_id) : null, reason: r?.reason ?? null }
}

/** A merchant's own organization only. */
export async function verifyOwnAuditChain(actor: Actor): Promise<ChainVerification> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'chain verification is per organization; open it from the organization')
  return verifyAuditChain(actor.orgId)
}
