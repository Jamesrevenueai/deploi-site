/** CSV import: header auto-detection, column mapping, dedupe on email + agency_name. */
import Papa from 'papaparse'
import type { Db } from '../db'
import { PROGRAMS } from './stages'

export const IMPORT_FIELDS = ['agency_name', 'owner_name', 'email', 'phone', 'city', 'county', 'state', 'programs', 'source', 'owner_notes'] as const
export type ImportField = typeof IMPORT_FIELDS[number]
export type Mapping = Partial<Record<ImportField, string>>

const HINTS: Record<ImportField, RegExp> = {
  agency_name: /^(agency|company|organi[sz]ation|business|name)$|agency.?name|company.?name/i,
  owner_name: /owner|contact|first.?name|full.?name|person/i,
  email: /e-?mail/i,
  phone: /phone|mobile|cell|tel/i,
  city: /city|town/i,
  county: /county/i,
  state: /^state$|province/i,
  programs: /program|waiver|payer/i,
  source: /source|list|campaign/i,
  owner_notes: /note|comment/i,
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  const headers = res.meta.fields ?? []
  return { headers, rows: res.data }
}

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {}
  const used = new Set<string>()
  for (const f of IMPORT_FIELDS) {
    const h = headers.find(h => !used.has(h) && HINTS[f].test(h))
    if (h) { m[f] = h; used.add(h) }
  }
  return m
}

export function normalizePrograms(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(/[;,|/]/).map(s => s.trim()).filter(Boolean).map(s => {
    const k = s.toLowerCase().replace(/[^a-z]/g, '')
    if (k === 'passport') return 'PASSPORT'
    if (k === 'ohcw' || k.includes('homecarewaiver')) return 'OHCW'
    if (k === 'mycare') return 'MyCare'
    if (k === 'dodd') return 'DODD'
    if (k.includes('private')) return 'private-pay'
    return s
  }).filter(p => (PROGRAMS as readonly string[]).includes(p))
}

export type ImportRow = { agency_name: string; owner_name: string | null; email: string | null; phone: string | null; city: string | null; county: string | null; state: string; programs: string[]; source: string; owner_notes: string | null }

export function applyMapping(rows: Record<string, string>[], mapping: Mapping, defaultSource = 'csv'): { rows: ImportRow[]; rejected: number } {
  const out: ImportRow[] = []
  let rejected = 0
  const get = (r: Record<string, string>, f: ImportField) => { const h = mapping[f]; return h ? (r[h] ?? '').trim() : '' }
  for (const r of rows) {
    const agency = get(r, 'agency_name')
    if (!agency) { rejected++; continue }
    const email = get(r, 'email').toLowerCase() || null
    out.push({
      agency_name: agency, owner_name: get(r, 'owner_name') || null, email, phone: get(r, 'phone') || null,
      city: get(r, 'city') || null, county: get(r, 'county') || null, state: (get(r, 'state') || 'OH').toUpperCase().slice(0, 2),
      programs: normalizePrograms(get(r, 'programs')), source: get(r, 'source') || defaultSource, owner_notes: get(r, 'owner_notes') || null,
    })
  }
  return { rows: out, rejected }
}

/** Inserts rows, skipping any whose (email, agency_name) already exists. Returns counts. */
export async function importRows(db: Db, rows: ImportRow[]): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0
  const seen = new Set<string>()
  for (const r of rows) {
    const key = `${r.email ?? ''}|${r.agency_name.toLowerCase()}`
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    const dup = r.email
      ? await db.one('select id from prospects where lower(email) = $1 and lower(agency_name) = $2', [r.email, r.agency_name.toLowerCase()])
      : await db.one('select id from prospects where email is null and lower(agency_name) = $1', [r.agency_name.toLowerCase()])
    if (dup) { skipped++; continue }
    await db.query(
      `insert into prospects (agency_name, owner_name, email, phone, city, county, state, programs, source, owner_notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.agency_name, r.owner_name, r.email, r.phone, r.city, r.county, r.state, r.programs, r.source, r.owner_notes])
    imported++
  }
  return { imported, skipped }
}
