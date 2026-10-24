/**
 * Import normalised visit rows into `visits`, then derive and upsert `evv_exceptions`.
 * Runs inside withUser(staff) so RLS and the audit trigger apply.
 *
 * Safe re-import: an existing visit is compared field by field; when anything changed, the previous row
 * is written to visit_revisions first (flagged `reviewed` when the visit had corrected/dismissed exceptions),
 * then the visit is updated with the new evidence and the import id. Unchanged visits are left untouched.
 * Corrected / dismissed exceptions are never reopened by an import: a human decided.
 * Deadlines come only from a matching rule set (lib/evv/window.ts); without one window_closes_at stays null.
 */
import type { Db } from '../db'
import { log } from '../log'
import { deriveExceptions } from './rules'
import { loadRuleSets, pickRuleSet, windowCloses, type RuleSet } from './window'
import { normalizeRow, toUnits, type Mapping, type UnitRule, DEFAULT_UNIT_RULE } from './mappers'
import type { AuthSlice, RuleVisit, VisitInput } from './types'
import { parseCsv as parseCsvShared, type RowError } from '../imports'

export type IngestCounts = {
  rows: number; skipped: number; imported: number; updated: number; unchanged: number; revisions: number; duplicates: number
  exceptionsOpened: number; exceptionsClosed: number; noDeadline: number; errors: RowError[]
}

export const parseCsv = parseCsvShared

type Person = { id: string; name: string; program: string | null }
async function nameIndex(db: Db, table: 'clients' | 'aides', agencyId: string): Promise<Map<string, Person>> {
  const rows = await db.query<Person>(`select id, lower(trim(first_name || ' ' || last_name)) as name${table === 'clients' ? ', program' : ', null::text as program'} from ${table} where agency_id = $1`, [agencyId])
  const m = new Map<string, Person>()
  for (const r of rows) m.set(r.name, r)
  return m
}
const key = (n: string | null) => (n ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
/** "Last, First" -> "first last" */
function nameVariants(n: string | null): string[] {
  const k = key(n)
  if (!k) return []
  const out = [k]
  if (k.includes(',')) { const [a, b] = k.split(',').map(s => s.trim()); if (a && b) out.push(`${b} ${a}`) }
  return out
}

export async function loadAuths(db: Db, agencyId: string): Promise<AuthSlice[]> {
  const rows = await db.query<{ client_id: string; service_code: string; units_authorized: number; units_used: number; starts_on: string; ends_on: string }>(
    'select client_id, service_code, units_authorized, units_used, starts_on::text, ends_on::text from authorizations where agency_id = $1', [agencyId])
  return rows.map(r => ({ ...r, starts_on: new Date(r.starts_on + 'T00:00:00Z'), ends_on: new Date(r.ends_on + 'T00:00:00Z') }))
}

/** The evidence columns a re-import may change; anything else on the row is ours. */
const EVIDENCE = ['client_id', 'aide_id', 'service_code', 'scheduled_start', 'scheduled_end', 'actual_start', 'actual_end', 'verification_status', 'gps_in_flag', 'gps_out_flag', 'units'] as const
type VisitRow = Record<string, unknown> & { id: string }
const same = (a: unknown, b: unknown) => {
  const na = a instanceof Date ? a.toISOString() : a, nb = b instanceof Date ? b.toISOString() : b
  return (na ?? null) === (nb ?? null)
}

export type IngestOpts = { source: 'sandata' | 'generic' | 'manual'; state?: string | null; now?: Date; importId?: string | null; payer?: string | null }

export async function ingestVisits(db: Db, agencyId: string, inputs: VisitInput[], opts: IngestOpts): Promise<IngestCounts> {
  const now = opts.now ?? new Date()
  const counts: IngestCounts = { rows: inputs.length, skipped: 0, imported: 0, updated: 0, unchanged: 0, revisions: 0, duplicates: 0, exceptionsOpened: 0, exceptionsClosed: 0, noDeadline: 0, errors: [] }
  const clients = await nameIndex(db, 'clients', agencyId)
  const aides = await nameIndex(db, 'aides', agencyId)
  const auths = await loadAuths(db, agencyId)
  const rules = await loadRuleSets(db, agencyId, opts.state)
  const seenKeys = new Map<string, number>()

  for (let i = 0; i < inputs.length; i++) {
    const v = inputs[i]
    const rowNo = v.row ?? i + 1
    if (seenKeys.has(v.vendor_visit_key)) { counts.duplicates++; counts.skipped++; counts.errors.push({ row: rowNo, field: 'vendor_visit_key', message: `duplicate visit key ${v.vendor_visit_key}, first seen on row ${seenKeys.get(v.vendor_visit_key)}; this row ignored` }); continue }
    seenKeys.set(v.vendor_visit_key, rowNo)
    const client = nameVariants(v.client_name).map(n => clients.get(n)).find(Boolean) ?? null
    const aide = nameVariants(v.employee_name).map(n => aides.get(n)).find(Boolean) ?? null
    const clientId = client?.id ?? null
    const visitDate = v.scheduled_start ?? v.actual_start ?? null
    const rule: RuleSet | null = pickRuleSet(rules, { agencyId, state: opts.state, program: client?.program ?? null, payer: opts.payer ?? null, date: visitDate })
    const unitRule: UnitRule = rule ? { unitMinutes: rule.unit_minutes, rounding: rule.unit_rounding } : DEFAULT_UNIT_RULE
    // units derived at parse time used the default rule; redo them with the resolved one (file units are never touched)
    let units = v.units
    if (v.units_derived && v.actual_start && v.actual_end) units = toUnits((v.actual_end.getTime() - v.actual_start.getTime()) / 60_000, unitRule.unitMinutes, unitRule.rounding)

    const existing = await db.one<VisitRow>('select * from visits where agency_id = $1 and vendor_visit_key = $2 for update', [agencyId, v.vendor_visit_key])
    let visitId: string
    if (!existing) {
      const row = await db.one<{ id: string }>(
        `insert into visits (agency_id, client_id, aide_id, service_code, vendor_visit_key, scheduled_start, scheduled_end, actual_start, actual_end,
                             verification_status, gps_in_flag, gps_out_flag, units, source, import_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [agencyId, clientId, aide?.id ?? null, v.service_code, v.vendor_visit_key, v.scheduled_start, v.scheduled_end, v.actual_start, v.actual_end,
         v.verification_status, v.gps_in_flag, v.gps_out_flag, units, opts.source, opts.importId ?? null])
      if (!row) { counts.skipped++; continue }
      visitId = row.id
      counts.imported++
    } else {
      visitId = existing.id
      const next: Record<string, unknown> = {
        client_id: clientId ?? existing.client_id, aide_id: aide?.id ?? existing.aide_id, service_code: v.service_code,
        scheduled_start: v.scheduled_start, scheduled_end: v.scheduled_end, actual_start: v.actual_start, actual_end: v.actual_end,
        verification_status: v.verification_status, gps_in_flag: v.gps_in_flag, gps_out_flag: v.gps_out_flag, units,
      }
      const changed = EVIDENCE.filter(f => !same(existing[f], next[f]))
      if (!changed.length) { counts.unchanged++ }
      else {
        const reviewed = await db.one<{ n: string }>("select count(*)::text as n from evv_exceptions where visit_id = $1 and status in ('corrected','dismissed')", [visitId])
        await db.query('insert into visit_revisions (visit_id, agency_id, import_id, previous, changed_fields, reviewed) values ($1,$2,$3,$4,$5,$6)',
          [visitId, agencyId, opts.importId ?? null, JSON.stringify(existing), changed, Number(reviewed?.n ?? 0) > 0])
        counts.revisions++
        await db.query(
          `update visits set client_id = $2, aide_id = $3, service_code = $4, scheduled_start = $5, scheduled_end = $6, actual_start = $7, actual_end = $8,
             verification_status = $9, gps_in_flag = $10, gps_out_flag = $11, units = $12, source = $13, import_id = coalesce($14, import_id) where id = $1`,
          [visitId, next.client_id, next.aide_id, next.service_code, next.scheduled_start, next.scheduled_end, next.actual_start, next.actual_end,
           next.verification_status, next.gps_in_flag, next.gps_out_flag, next.units, opts.source, opts.importId ?? null])
        counts.updated++
      }
    }

    const rv: RuleVisit = { ...v, units, client_id: clientId }
    const ctx = { authorizations: auths.filter(a => a.client_id === clientId), toleranceMin: rule?.duration_tolerance_min ?? DEFAULT_TOLERANCE_MIN, windowDays: rule?.correction_window_days ?? null, unitMinutes: unitRule.unitMinutes, unitRounding: unitRule.rounding, now }
    const results = deriveExceptions(rv, ctx)
    const closes = windowCloses(visitDate ?? now, rule)
    if (results.length && !closes) counts.noDeadline++
    const firing = results.map(r => r.rule)
    for (const r of results) {
      const prior = await db.one<{ status: string }>('select status from evv_exceptions where visit_id = $1 and rule = $2', [visitId, r.rule])
      if (!prior) {
        await db.query(
          `insert into evv_exceptions (agency_id, visit_id, rule, detail, severity, opened_at, window_closes_at, status, rule_set_id)
           values ($1,$2,$3,$4,$5,$6,$7,'open',$8)`, [agencyId, visitId, r.rule, r.detail, r.severity, visitDate ?? now, closes, rule?.id ?? null])
        counts.exceptionsOpened++
      } else if (prior.status === 'open') {
        await db.query('update evv_exceptions set detail = $3, severity = $4, window_closes_at = $5, rule_set_id = $6 where visit_id = $1 and rule = $2', [visitId, r.rule, r.detail, r.severity, closes, rule?.id ?? null])
      }
      // corrected / dismissed rows are left alone: a human already decided
    }
    const closed = await db.query<{ id: string }>(
      `update evv_exceptions set status = 'corrected', corrected_at = now(), correction_note = 'Resolved on re-import: rule no longer fires'
       where visit_id = $1 and status = 'open' and not (rule = any($2::text[])) returning id`, [visitId, firing])
    counts.exceptionsClosed += closed.length
  }
  log.info('evv.ingest', { agencyId, source: opts.source, importId: opts.importId ?? null, ...counts, errors: counts.errors.length })
  return counts
}

/** Tolerance used only when no rule set resolves; the duration rule needs some tolerance to be meaningful. */
export const DEFAULT_TOLERANCE_MIN = 15

/** Parse + map + ingest a CSV in one go (used by tests and the commit step). Row errors carry 1-based data row numbers. */
export async function ingestCsv(db: Db, agencyId: string, csvText: string, mapping: Mapping, opts: IngestOpts & { timezone?: string }) {
  const { rows } = parseCsv(csvText)
  const inputs: VisitInput[] = []
  const errors: RowError[] = []
  rows.forEach((r, i) => {
    const n = normalizeRow(r, mapping, opts.timezone ?? 'America/New_York')
    if (n) inputs.push({ ...n, row: i + 1 })
    else {
      const k = mapping.vendor_visit_key ? (r[mapping.vendor_visit_key] ?? '').trim() : ''
      errors.push({ row: i + 1, field: k ? 'service_code' : 'vendor_visit_key', message: k ? 'service code is required' : 'visit key is required' })
    }
  })
  const counts = await ingestVisits(db, agencyId, inputs, opts)
  counts.rows = rows.length
  counts.skipped += errors.length
  counts.errors = [...errors, ...counts.errors].sort((a, b) => a.row - b.row)
  return counts
}

export function summarize(c: IngestCounts): string {
  const parts = [`${c.imported} visits imported`, `${c.updated} updated`, `${c.exceptionsOpened} exceptions opened`]
  if (c.exceptionsClosed) parts.push(`${c.exceptionsClosed} closed`)
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`)
  if (c.revisions) parts.push(`${c.revisions} revision${c.revisions === 1 ? '' : 's'} kept`)
  if (c.duplicates) parts.push(`${c.duplicates} duplicate${c.duplicates === 1 ? '' : 's'}`)
  if (c.skipped) parts.push(`${c.skipped} rows skipped`)
  if (c.noDeadline) parts.push(`${c.noDeadline} without a configured deadline`)
  return parts.join(', ')
}
