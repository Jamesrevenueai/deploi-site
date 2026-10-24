/** CSV parsing, hashing, header auto-mapping and templates shared by every import kind. */
import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import { IMPORT_SPECS, type ImportKind, type ImportSpec } from './specs'

export type Mapping = Record<string, string>

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const r = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() })
  const headers = (r.meta.fields ?? []).filter(Boolean)
  return { headers, rows: r.data }
}

/** Content hash of the uploaded file (line endings normalised, trailing whitespace ignored) for "already imported". */
export function fileSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trimEnd()).digest('hex')
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Map spec fields to file headers: exact synonym first, then a partial match; a header is used once. */
export function detectMapping(spec: ImportSpec, headers: string[], preset?: Mapping): Mapping {
  const m: Mapping = {}
  const hn = headers.map(h => ({ h, n: norm(h) }))
  if (preset) for (const f of spec.fields) { const want = preset[f.key]; if (want && headers.includes(want)) m[f.key] = want }
  for (const f of spec.fields) {
    if (m[f.key]) continue
    const syns = f.synonyms.map(norm)
    const used = new Set(Object.values(m))
    const exact = hn.find(x => syns.includes(x.n) && !used.has(x.h))
    if (exact) { m[f.key] = exact.h; continue }
    const partial = hn.find(x => syns.some(s => s.length > 3 && x.n.includes(s)) && !used.has(x.h))
    if (partial) m[f.key] = partial.h
  }
  return m
}

export function missingRequired(spec: ImportSpec, m: Mapping): string[] {
  return spec.fields.filter(f => f.required && !m[f.key]).map(f => f.key)
}

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** Downloadable template: documented headers + one synthetic example row. */
export function templateCsv(kind: ImportKind): string {
  const spec = IMPORT_SPECS[kind]
  const headers = spec.fields.map(f => f.key)
  const example = spec.fields.map(f => esc(f.example))
  return `${headers.join(',')}\n${example.join(',')}\n`
}

export function templateHeaders(kind: ImportKind): string[] { return IMPORT_SPECS[kind].fields.map(f => f.key) }
