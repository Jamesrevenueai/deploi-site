/** Read queries shared by the staff and client EVV pages. Reads are audited. */
import type { Db } from '../db'
import { daysLeft, ruleSourceLabel, DEADLINE_NOT_CONFIGURED } from './window'

/** pg returns timestamptz as Date; the pages and CSV want ISO strings. */
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const TS = ['opened_at', 'window_closes_at', 'corrected_at', 'scheduled_start', 'actual_start'] as const
function isoRow<T extends Record<string, unknown>>(r: T): T { const o: Record<string, unknown> = { ...r }; for (const k of TS) if (k in o) o[k] = iso(o[k]); return o as T }

export type ExceptionRow = {
  id: string; visit_id: string; rule: string; detail: string | null; severity: string; status: string
  opened_at: string; window_closes_at: string | null; corrected_at: string | null; correction_note: string | null
  vendor_visit_key: string | null; service_code: string; scheduled_start: string | null; actual_start: string | null; units: number | null
  client_initials: string | null; aide_initials: string | null; agency_name: string; timezone: string
  rule_source_name: string | null; rule_source_version: string | null; rule_verified: boolean | null
  /** null = deadline not configured (no rule set matched) */
  days_left: number | null
  rule_source: string
}

const BASE = `
  select e.id, e.visit_id, e.rule, e.detail, e.severity, e.status, e.opened_at, e.window_closes_at, e.corrected_at, e.correction_note,
         v.vendor_visit_key, v.service_code, v.scheduled_start, v.actual_start, v.units,
         case when c.id is null then null else left(c.first_name,1) || '.' || left(c.last_name,1) || '.' end as client_initials,
         case when a.id is null then null else left(a.first_name,1) || '.' || left(a.last_name,1) || '.' end as aide_initials,
         g.name as agency_name, g.timezone,
         rs.source_name as rule_source_name, rs.source_version as rule_source_version, rs.verified as rule_verified
  from evv_exceptions e
  join visits v on v.id = e.visit_id
  left join clients c on c.id = v.client_id
  left join aides a on a.id = v.aide_id
  left join evv_rule_sets rs on rs.id = e.rule_set_id
  join agencies g on g.id = e.agency_id`

function withSource<T extends { window_closes_at: string | null; rule_source_name: string | null; rule_source_version: string | null; rule_verified: boolean | null }>(r: T, now: Date) {
  const hasRule = r.rule_source_name != null || r.rule_verified != null
  return {
    ...r,
    days_left: r.window_closes_at ? daysLeft(new Date(r.window_closes_at), now) : null,
    rule_source: r.window_closes_at ? (hasRule ? ruleSourceLabel({ source_name: r.rule_source_name, source_version: r.rule_source_version, verified: Boolean(r.rule_verified) }) : 'seeded deadline') : DEADLINE_NOT_CONFIGURED,
  }
}

export async function listExceptions(db: Db, agencyId: string, status: 'open' | 'corrected' | 'dismissed', now = new Date()): Promise<ExceptionRow[]> {
  const order = status === 'open' ? 'e.window_closes_at asc nulls last, e.opened_at asc' : 'coalesce(e.corrected_at, e.opened_at) desc'
  const rows = await db.query<ExceptionRow>(`${BASE} where e.agency_id = $1 and e.status = $2 order by ${order} limit 500`, [agencyId, status])
  await db.auditRead('evv_exceptions', agencyId, rows.map(r => r.id))
  return rows.map(isoRow).map(r => withSource(r, now))
}

export type HoldRow = {
  visit_id: string; vendor_visit_key: string | null; service_code: string; scheduled_start: string | null; units: number | null
  client_initials: string | null; aide_initials: string | null; open_rules: string[]; window_closes_at: string | null; timezone: string
  rule_source_name: string | null; rule_source_version: string | null; rule_verified: boolean | null
  rule_source: string; days_left: number | null
}

/** Visits with any open exception: advisory "review before billing" list. */
export async function billingHold(db: Db, agencyId: string, now = new Date()): Promise<HoldRow[]> {
  const rows = await db.query<HoldRow>(
    `select v.id as visit_id, v.vendor_visit_key, v.service_code, v.scheduled_start, v.units,
            case when c.id is null then null else left(c.first_name,1) || '.' || left(c.last_name,1) || '.' end as client_initials,
            case when a.id is null then null else left(a.first_name,1) || '.' || left(a.last_name,1) || '.' end as aide_initials,
            array_agg(e.rule order by e.rule) as open_rules, min(e.window_closes_at) as window_closes_at, g.timezone,
            (array_agg(rs.source_name order by e.window_closes_at nulls last))[1] as rule_source_name,
            (array_agg(rs.source_version order by e.window_closes_at nulls last))[1] as rule_source_version,
            (array_agg(rs.verified order by e.window_closes_at nulls last))[1] as rule_verified
     from visits v
     join evv_exceptions e on e.visit_id = v.id and e.status = 'open'
     left join evv_rule_sets rs on rs.id = e.rule_set_id
     left join clients c on c.id = v.client_id
     left join aides a on a.id = v.aide_id
     join agencies g on g.id = v.agency_id
     where v.agency_id = $1 and v.claim_status <> 'paid'
     group by v.id, c.id, a.id, g.timezone
     order by min(e.window_closes_at) asc nulls last`, [agencyId])
  await db.auditRead('visits', agencyId, rows.map(r => r.visit_id))
  return rows.map(isoRow).map(r => withSource(r, now))
}

export async function exceptionCounts(db: Db, agencyId: string) {
  const r = await db.one<{ open: string; corrected: string; dismissed: string; hold: string; no_deadline: string }>(
    `select count(*) filter (where status = 'open')::text as open,
            count(*) filter (where status = 'corrected')::text as corrected,
            count(*) filter (where status = 'dismissed')::text as dismissed,
            count(distinct visit_id) filter (where status = 'open')::text as hold,
            count(*) filter (where status = 'open' and window_closes_at is null)::text as no_deadline
     from evv_exceptions where agency_id = $1`, [agencyId])
  return { open: Number(r?.open ?? 0), corrected: Number(r?.corrected ?? 0), dismissed: Number(r?.dismissed ?? 0), hold: Number(r?.hold ?? 0), noDeadline: Number(r?.no_deadline ?? 0) }
}

export type RevisionRow = { id: string; visit_id: string; import_id: string | null; changed_fields: string[]; reviewed: boolean; at: string; previous: Record<string, unknown> }

export async function listRevisions(db: Db, agencyId: string, visitId: string): Promise<RevisionRow[]> {
  const rows = await db.query<RevisionRow>('select id, visit_id, import_id, changed_fields, reviewed, at, previous from visit_revisions where agency_id = $1 and visit_id = $2 order by at desc', [agencyId, visitId])
  await db.auditRead('visit_revisions', agencyId, rows.map(r => r.id))
  return rows.map(r => ({ ...r, at: iso(r.at)! }))
}
