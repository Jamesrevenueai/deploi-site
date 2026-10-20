/**
 * Import normalised visit rows into `visits`, then derive and upsert `evv_exceptions`.
 * Runs inside withUser(staff) so RLS and the audit trigger apply.
 */
import Papa from 'papaparse'
import type { Db } from '../db'
import { env } from '../env'
import { log } from '../log'
import { deriveExceptions } from './rules'
import { windowCloses, windowDays } from './window'
import { normalizeRow, type Mapping } from './mappers'
import type { AuthSlice, RuleVisit, VisitInput } from './types'

export type IngestCounts = { rows: number; skipped: number; imported: number; updated: number; exceptionsOpened: number; exceptionsClosed: number }

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const r = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() })
  const headers = (r.meta.fields ?? []).filter(Boolean)
  return { headers, rows: r.data }
}

type Person = { id: string; name: string }
async function nameIndex(db: Db, table: 'clients' | 'aides', agencyId: string): Promise<Map<string, string>> {
  const rows = await db.query<Person>(`select id, lower(trim(first_name || ' ' || last_name)) as name from ${table} where agency_id = $1`, [agencyId])
  const m = new Map<string, string>()
  for (const r of rows) m.set(r.name, r.id)
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

export async function ingestVisits(
  db: Db, agencyId: string, inputs: VisitInput[],
  opts: { source: 'sandata' | 'generic' | 'manual'; state?: string | null; now?: Date },
): Promise<IngestCounts> {
  const now = opts.now ?? new Date()
  const counts: IngestCounts = { rows: inputs.length, skipped: 0, imported: 0, updated: 0, exceptionsOpened: 0, exceptionsClosed: 0 }
  const clients = await nameIndex(db, 'clients', agencyId)
  const aides = await nameIndex(db, 'aides', agencyId)
  const auths = await loadAuths(db, agencyId)
  const wDays = windowDays(opts.state)
  const ctxBase = { toleranceMin: env.evvToleranceMin, windowDays: wDays, now }

  for (const v of inputs) {
    const clientId = nameVariants(v.client_name).map(n => clients.get(n)).find(Boolean) ?? null
    const aideId = nameVariants(v.employee_name).map(n => aides.get(n)).find(Boolean) ?? null
    const existing = await db.one<{ id: string }>('select id from visits where agency_id = $1 and vendor_visit_key = $2', [agencyId, v.vendor_visit_key])
    const row = await db.one<{ id: string }>(
      `insert into visits (agency_id, client_id, aide_id, service_code, vendor_visit_key, scheduled_start, scheduled_end, actual_start, actual_end,
                           verification_status, gps_in_flag, gps_out_flag, units, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (agency_id, vendor_visit_key) where vendor_visit_key is not null do update set
         client_id = coalesce(excluded.client_id, visits.client_id), aide_id = coalesce(excluded.aide_id, visits.aide_id),
         service_code = excluded.service_code, scheduled_start = excluded.scheduled_start, scheduled_end = excluded.scheduled_end,
         actual_start = excluded.actual_start, actual_end = excluded.actual_end, verification_status = excluded.verification_status,
         gps_in_flag = excluded.gps_in_flag, gps_out_flag = excluded.gps_out_flag, units = excluded.units, source = excluded.source
       returning id`,
      [agencyId, clientId, aideId, v.service_code, v.vendor_visit_key, v.scheduled_start, v.scheduled_end, v.actual_start, v.actual_end,
       v.verification_status, v.gps_in_flag, v.gps_out_flag, v.units, opts.source])
    if (!row) { counts.skipped++; continue }
    if (existing) counts.updated++; else counts.imported++

    const rv: RuleVisit = { ...v, client_id: clientId }
    const results = deriveExceptions(rv, { ...ctxBase, authorizations: auths.filter(a => a.client_id === clientId) })
    const visitDate = v.scheduled_start ?? v.actual_start ?? now
    const closes = windowCloses(visitDate, opts.state)
    const firing = results.map(r => r.rule)
    for (const r of results) {
      const prior = await db.one<{ status: string }>('select status from evv_exceptions where visit_id = $1 and rule = $2', [row.id, r.rule])
      if (!prior) {
        await db.query(
          `insert into evv_exceptions (agency_id, visit_id, rule, detail, severity, opened_at, window_closes_at, status)
           values ($1,$2,$3,$4,$5,$6,$7,'open')`, [agencyId, row.id, r.rule, r.detail, r.severity, visitDate, closes])
        counts.exceptionsOpened++
      } else if (prior.status === 'open') {
        await db.query('update evv_exceptions set detail = $3, severity = $4, window_closes_at = $5 where visit_id = $1 and rule = $2', [row.id, r.rule, r.detail, r.severity, closes])
      }
      // corrected / dismissed rows are left alone: a human already decided
    }
    const closed = await db.query<{ id: string }>(
      `update evv_exceptions set status = 'corrected', corrected_at = now(), correction_note = 'Resolved on re-import: rule no longer fires'
       where visit_id = $1 and status = 'open' and not (rule = any($2::text[])) returning id`, [row.id, firing])
    counts.exceptionsClosed += closed.length
  }
  log.info('evv.ingest', { agencyId, source: opts.source, ...counts })
  return counts
}

/** Parse + map + ingest a CSV in one go (used by tests and the commit step). */
export async function ingestCsv(db: Db, agencyId: string, csvText: string, mapping: Mapping, opts: { source: 'sandata' | 'generic'; state?: string | null; timezone?: string; now?: Date }) {
  const { rows } = parseCsv(csvText)
  const inputs: VisitInput[] = []
  let skipped = 0
  for (const r of rows) { const n = normalizeRow(r, mapping, opts.timezone ?? 'America/New_York'); if (n) inputs.push(n); else skipped++ }
  const counts = await ingestVisits(db, agencyId, inputs, opts)
  counts.rows = rows.length
  counts.skipped += skipped
  return counts
}

export function summarize(c: IngestCounts): string {
  return `${c.imported} visits imported, ${c.updated} updated, ${c.exceptionsOpened} exceptions opened${c.exceptionsClosed ? `, ${c.exceptionsClosed} closed` : ''}${c.skipped ? `, ${c.skipped} rows skipped` : ''}`
}
