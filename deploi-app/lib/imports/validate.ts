/**
 * Row-level validation and duplicate detection. Pure: rows in, normalised values + an error list with
 * 1-based data row numbers (row 1 is the first data row under the header) out.
 */
import { parseDateTime, parseFlag, parseStatus } from '../evv/mappers'
import type { FieldSpec, ImportSpec } from './specs'
import type { Mapping } from './csv'

export type RowError = { row: number; field: string | null; message: string }
export type Normalized = Record<string, unknown>
export type ValidRow = { row: number; values: Normalized; identity: string | null }

export type ValidationResult = {
  valid: ValidRow[]
  errors: RowError[]
  /** rows dropped as duplicates of an earlier row in the same file */
  duplicatesInFile: number
}

export function normalizePhone(v: string): string | null {
  const digits = v.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseDateOnly(v: string): string | null {
  const s = v.trim()
  let y: string, mo: string, d: string
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) [y, mo, d] = [m[1], m[2], m[3]]
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (!m) return null
    ;[y, mo, d] = [m[3], m[1].padStart(2, '0'), m[2].padStart(2, '0')]
  }
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  const back = new Date(t)
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return null
  return `${y}-${mo}-${d}`
}

function coerce(f: FieldSpec, raw: string, tz: string): { value: unknown; error?: string } {
  const v = raw.trim()
  if (!v) return { value: null }
  switch (f.type) {
    case 'phone': { const p = normalizePhone(v); return p ? { value: p } : { value: null, error: `invalid phone "${v}" (use +1XXXXXXXXXX or 10 digits)` } }
    case 'email': return EMAIL.test(v) ? { value: v.toLowerCase() } : { value: null, error: `invalid email "${v}"` }
    case 'datetime': { const d = parseDateTime(v, tz); return d ? { value: d } : { value: null, error: `invalid date/time "${v}" (expected YYYY-MM-DD HH:MM or MM/DD/YYYY h:mm AM)` } }
    case 'date': { const d = parseDateOnly(v); return d ? { value: d } : { value: null, error: `invalid date "${v}" (expected YYYY-MM-DD)` } }
    case 'number': { const n = Number(v); if (!Number.isFinite(n)) return { value: null, error: `"${v}" is not a number` }; if (n < 0) return { value: null, error: `${v} is negative` }; return { value: n } }
    case 'flag': return { value: parseFlag(v) }
    case 'status': return { value: parseStatus(v) }
    case 'code': return { value: v.toUpperCase() }
    case 'list': return { value: v.split(/[;|,]/).map(s => s.trim().toUpperCase()).filter(Boolean) }
    default: return { value: v }
  }
}

/** Identity string for duplicate detection: first identity rule whose fields are all present. */
export function identityOf(spec: ImportSpec, values: Normalized): string | null {
  for (const rule of spec.identity) {
    const parts = rule.fields.map(f => values[f]).filter(v => v != null && String(v).trim() !== '').map(v => String(v).toLowerCase().trim())
    if (parts.length === rule.fields.length) return `${rule.by}:${parts.join('|')}`
  }
  return null
}

export function validateRows(spec: ImportSpec, rows: Record<string, string>[], mapping: Mapping, opts: { timezone?: string } = {}): ValidationResult {
  const tz = opts.timezone ?? 'America/New_York'
  const errors: RowError[] = []
  const valid: ValidRow[] = []
  const seen = new Map<string, number>()
  let duplicatesInFile = 0
  rows.forEach((raw, i) => {
    const row = i + 1
    const values: Normalized = {}
    let bad = false
    for (const f of spec.fields) {
      const h = mapping[f.key]
      const cell = h ? String(raw[h] ?? '') : ''
      if (f.required && !cell.trim()) { errors.push({ row, field: f.key, message: `${f.label} is required` }); bad = true; continue }
      const c = coerce(f, cell, tz)
      if (c.error) { errors.push({ row, field: f.key, message: c.error }); bad = true }
      values[f.key] = c.value
    }
    if (bad) return
    const id = identityOf(spec, values)
    if (id && seen.has(id)) { duplicatesInFile++; errors.push({ row, field: null, message: `duplicate of row ${seen.get(id)} (${id.split(':')[0]})` }); return }
    if (id) seen.set(id, row)
    valid.push({ row, values, identity: id })
  })
  return { valid, errors, duplicatesInFile }
}
