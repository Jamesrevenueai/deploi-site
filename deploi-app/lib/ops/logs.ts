/**
 * Operational logs: structured job and case logs with correlation ids, queryable by staff.
 *
 *   writeOpsLog()   one row in ops_logs (and the same JSON line on stdout through lib/log.ts). Correlation:
 *                   org_id, job_id, case_id + case_ref (looked up from the case id when not given), and a free
 *                   correlation id (an inbound email id, a webhook id ...). The detail goes through redact()
 *                   (personal details removed by key name) and every string is masked for e-mail addresses
 *                   and phone numbers, so a log row never carries a person's contact details.
 *   jobLog()        called by the job queue after each attempt settles (lib/jobs/queue.ts)
 *   queryOpsLogs()  staff: ops_logs and the case history (case_events), merged, newest first, filtered by
 *                   organization, job id, case ref, correlation id, level or event prefix. Case event text is
 *                   masked the same way.
 * Writing a log never fails the work it describes.
 */
import { admin, type Db } from '../db'
import { log, redact } from '../log'

export type OpsLevel = 'info' | 'warn' | 'error'
export type OpsLogInput = {
  level?: OpsLevel; event: string; orgId?: string | null; jobId?: string | null; caseId?: string | null; caseRef?: string | null
  correlationId?: string | null; summary?: string | null; detail?: Record<string, unknown>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT = /^[a-z][a-z0-9_.:-]{1,79}$/
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi
const PHONE = /(?<![\w-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g

/** Mask e-mail addresses (keep the domain) and phone numbers in free text. */
export function maskText(s: string): string {
  return s.replace(EMAIL, m => `[email]@${m.split('@')[1]}`).replace(PHONE, m => (/^\d{4}-\d{2}-\d{2}/.test(m.trim()) ? m : '[phone]'))
}
function maskDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof v === 'string') return maskText(v)
  if (Array.isArray(v)) return v.map(x => maskDeep(x, depth + 1))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x, depth + 1)]))
  return v
}
/** What is stored for a detail object: lib/log.ts redaction by key name, then masking of values. */
export const cleanDetail = (d: Record<string, unknown> | undefined) => maskDeep(redact(d ?? {})) as Record<string, unknown>

export async function writeOpsLog(i: OpsLogInput, db?: Db): Promise<void> {
  const level = i.level ?? 'info'
  if (!EVENT.test(i.event)) return
  const orgId = i.orgId && UUID.test(i.orgId) ? i.orgId : null
  const caseId = i.caseId && UUID.test(i.caseId) ? i.caseId : null
  const detail = cleanDetail(i.detail)
  const summary = i.summary ? maskText(String(i.summary)).slice(0, 500) : null
  log[level](i.event, { org_id: orgId, job_id: i.jobId ?? null, case_id: caseId, case_ref: i.caseRef ?? null, correlation_id: i.correlationId ?? null, ...detail })
  const write = (d: Db) => d.query(
    `insert into ops_logs (level, event, org_id, job_id, case_id, case_ref, correlation_id, summary, detail)
     select $1, $2, $3::uuid, $4::uuid, $5::uuid, coalesce($6, (select ref from cases where id = $5::uuid)), $7, $8, $9
     where $3::uuid is null or exists (select 1 from agencies where id = $3::uuid)`,
    [level, i.event, orgId, i.jobId && UUID.test(i.jobId) ? i.jobId : null, caseId, i.caseRef?.slice(0, 40) ?? null, i.correlationId?.slice(0, 120) ?? null, summary, JSON.stringify(detail)])
  try { await (db ? write(db) : admin(write)) } catch { /* a log row never fails the work */ }
}

type JobLike = { id: string; kind: string; org_id: string | null; agent_id: string | null; attempts: number; max_attempts: number; payload: Record<string, unknown> | null }
type OutcomeLike = { status: string; error?: string; result?: Record<string, unknown> | null }

/** One row per settled job attempt: what ran, for whom, and how it ended (correlated by job, organization and case). */
export async function jobLog(job: JobLike, o: OutcomeLike, ms: number): Promise<void> {
  const p = job.payload ?? {}
  const caseId = typeof p.caseId === 'string' ? p.caseId : null
  const level: OpsLevel = o.status === 'dead' || o.status === 'failed' ? 'error' : o.status === 'queued' || o.status === 'lost_lease' ? 'warn' : 'info'
  const correlationId = ['messageId', 'agentId', 'inboundId', 'runId'].map(k => p[k]).find((v): v is string => typeof v === 'string') ?? null
  await writeOpsLog({
    level, event: `job.${o.status === 'queued' ? 'retry' : o.status}`, orgId: job.org_id, jobId: job.id, caseId, correlationId,
    summary: `${job.kind} attempt ${job.attempts}/${job.max_attempts}: ${o.status}${o.error ? ` (${o.error.slice(0, 200)})` : ''}`,
    detail: { kind: job.kind, attempts: job.attempts, agent_id: job.agent_id, duration_ms: ms, ...(o.result && typeof o.result === 'object' ? { result_keys: Object.keys(o.result).slice(0, 10) } : {}) },
  })
}

export type OpsLogRow = { source: 'ops' | 'case'; at: string; level: OpsLevel; event: string; org_id: string | null; job_id: string | null; case_id: string | null; case_ref: string | null; correlation_id: string | null; summary: string | null; detail: Record<string, unknown> }
export type OpsLogFilter = { orgId?: string; jobId?: string; caseRef?: string; correlationId?: string; level?: OpsLevel; eventPrefix?: string; since?: Date; limit?: number }

/** Staff query over ops_logs and case history. Any Db (RLS lets staff read all; a member reads only their own organization). */
export async function queryOpsLogs(db: Db, f: OpsLogFilter = {}): Promise<OpsLogRow[]> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500)
  const params: unknown[] = []
  const p = (v: unknown) => { params.push(v); return `$${params.length}` }
  const ow: string[] = [], cw: string[] = []
  if (f.orgId && UUID.test(f.orgId)) { const x = p(f.orgId); ow.push(`l.org_id = ${x}`); cw.push(`e.org_id = ${x}`) }
  if (f.jobId && UUID.test(f.jobId)) { const x = p(f.jobId); ow.push(`l.job_id = ${x}`); cw.push('false') }
  if (f.caseRef) { const x = p(f.caseRef.trim().toUpperCase()); ow.push(`l.case_ref = ${x}`); cw.push(`c.ref = ${x}`) }
  if (f.correlationId) { const x = p(f.correlationId.trim()); ow.push(`l.correlation_id = ${x}`); cw.push(`e.ref_id = ${x}`) }
  if (f.level) { const x = p(f.level); ow.push(`l.level = ${x}`); cw.push(`(case when e.to_status in ('failed','escalated','blocked') then 'warn' else 'info' end) = ${x}`) }
  if (f.eventPrefix) { const x = p(`${f.eventPrefix.replace(/[%_\\]/g, '')}%`); ow.push(`l.event like ${x}`); cw.push(`('case.' || e.type) like ${x}`) }
  if (f.since) { const x = p(f.since.toISOString()); ow.push(`l.at >= ${x}`); cw.push(`e.at >= ${x}`) }
  const lim = p(limit)
  const rows = await db.query<OpsLogRow>(
    `(select 'ops' as source, l.at, l.level, l.event, l.org_id, l.job_id::text, l.case_id::text, l.case_ref, l.correlation_id, l.summary, l.detail
        from ops_logs l ${ow.length ? `where ${ow.join(' and ')}` : ''} order by l.at desc limit ${lim})
     union all
     (select 'case' as source, e.at, case when e.to_status in ('failed','escalated','blocked') then 'warn' else 'info' end, 'case.' || e.type, e.org_id, null, e.case_id::text, c.ref,
        e.ref_id, e.summary, jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actor', e.actor, 'ref_type', e.ref_type)
        from case_events e join cases c on c.id = e.case_id ${cw.length ? `where ${cw.join(' and ')}` : ''} order by e.at desc limit ${lim})
     order by at desc limit ${lim}`, params)
  return rows.map(r => ({ ...r, at: new Date(r.at).toISOString(), summary: r.summary ? maskText(r.summary) : null, detail: cleanDetail(r.detail) }))
}

/** Delete operational log rows older than OPS_LOG_RETENTION_DAYS (default 30). Case history is not touched. */
export async function pruneOpsLogs(now = new Date()): Promise<number> {
  const d = Number((process.env.OPS_LOG_RETENTION_DAYS ?? '').trim())
  const days = Number.isInteger(d) && d >= 1 && d <= 730 ? d : 30
  return admin(async db => (await db.raw.query(`delete from ops_logs where at < $1::timestamptz - make_interval(days => $2::int)`, [now.toISOString(), days])).rowCount ?? 0)
}
