/**
 * Merchant reference files: price lists, SKU mappings and publication lists, uploaded as CSV.
 * Contents are data only: recognised columns are parsed into typed values, every other column is
 * ignored, and nothing in a file can change an agent's permissions. Each upload under the same name
 * becomes a new version; proposals record the version and row they relied on, so changed reference
 * data invalidates them. Duplicate keys are kept but marked ambiguous, and agents block on them.
 */
import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { audit } from '../engine/audit'

export type ReferenceKind = 'price_list' | 'sku_mapping' | 'publication_list'
export type RowError = { row: number; message: string }
export type PriceRow = { kind: 'price_list'; key: string; sku: string | null; variantId: string | null; price: string; compareAtPrice: string | null; currency: string | null; ambiguous: boolean }
export type SkuRow = { kind: 'sku_mapping'; key: string; matchBy: 'variant_id' | 'barcode' | 'handle_option'; variantId: string | null; barcode: string | null; handle: string | null; variantTitle: string | null; sku: string; ambiguous: boolean; duplicateTarget: boolean }
export type PublicationRow = { kind: 'publication_list'; key: string; productId: string | null; handle: string | null; published: boolean; ambiguous: boolean }
export type ReferenceRow = PriceRow | SkuRow | PublicationRow
export type ParsedReference = { rows: { rowNumber: number; row: ReferenceRow }[]; errors: RowError[]; columns: string[]; ambiguousKeys: number }

export const REFERENCE_TEMPLATES: Record<ReferenceKind, { columns: string[]; example: string[]; notes: string }> = {
  price_list: { columns: ['sku', 'variant_id', 'price', 'compare_at_price', 'currency'], example: ['NW-LTB-OAT', '', '89.00', '', 'USD'], notes: 'Identify each variant by sku or variant_id. price is required (up to 2 decimals). compare_at_price and currency are optional; currency must match the store currency.' },
  sku_mapping: { columns: ['variant_id', 'barcode', 'product_handle', 'variant_title', 'sku'], example: ['', '0890000000017', '', '', 'NW-WSB-01'], notes: 'Identify each variant by variant_id, or barcode, or product_handle + variant_title. sku is the correct SKU.' },
  publication_list: { columns: ['product_id', 'product_handle', 'published'], example: ['', 'walnut-serving-board', 'yes'], notes: 'Identify each product by product_id or product_handle. published is yes or no.' },
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const variantGid = (v: string) => (/^\d+$/.test(v) ? `gid://shopify/ProductVariant/${v}` : /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(v) ? v : null)
const productGid = (v: string) => (/^\d+$/.test(v) ? `gid://shopify/Product/${v}` : /^gid:\/\/shopify\/Product\/\d+$/.test(v) ? v : null)

/** Decimal string with up to 2 places -> canonical "12.30" (no floating point). */
export function canonicalMoney(v: string): string | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v.replace(/,/g, '').trim())
  if (!m) return null
  return `${String(Number(m[1]))}.${(m[2] ?? '').padEnd(2, '0')}`
}
export const moneyCents = (v: string) => { const c = canonicalMoney(v); return c === null ? null : Math.round(Number(c.replace('.', ''))) }

export function parseReference(kind: ReferenceKind, csv: string): ParsedReference {
  const r = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, '_') })
  const columns = (r.meta.fields ?? []).filter(Boolean)
  const errors: RowError[] = []
  const rows: { rowNumber: number; row: ReferenceRow }[] = []
  const need = (cols: string[]) => cols.some(c => columns.includes(c))
  if (kind === 'price_list' && (!columns.includes('price') || !need(['sku', 'variant_id']))) errors.push({ row: 0, message: 'needs a price column and a sku or variant_id column' })
  if (kind === 'sku_mapping' && (!columns.includes('sku') || !(need(['variant_id', 'barcode']) || (columns.includes('product_handle') && columns.includes('variant_title'))))) errors.push({ row: 0, message: 'needs a sku column and variant_id, barcode, or product_handle + variant_title' })
  if (kind === 'publication_list' && (!columns.includes('published') || !need(['product_id', 'product_handle']))) errors.push({ row: 0, message: 'needs a published column and a product_id or product_handle column' })
  if (errors.length) return { rows, errors, columns, ambiguousKeys: 0 }
  if (r.data.length > 20000) return { rows, errors: [{ row: 0, message: 'at most 20,000 rows per file' }], columns, ambiguousKeys: 0 }

  r.data.forEach((raw, i) => {
    const n = i + 2 // header is row 1
    if (kind === 'price_list') {
      const sku = clean(raw.sku) || null
      const variantId = clean(raw.variant_id) ? variantGid(clean(raw.variant_id)) : null
      if (clean(raw.variant_id) && !variantId) return void errors.push({ row: n, message: 'variant_id is not a Shopify variant id' })
      if (!sku && !variantId) return void errors.push({ row: n, message: 'needs sku or variant_id' })
      const price = canonicalMoney(clean(raw.price))
      if (!price) return void errors.push({ row: n, message: 'price must be a number with at most 2 decimals' })
      const cap = clean(raw.compare_at_price) ? canonicalMoney(clean(raw.compare_at_price)) : null
      if (clean(raw.compare_at_price) && !cap) return void errors.push({ row: n, message: 'compare_at_price must be a number with at most 2 decimals' })
      const currency = clean(raw.currency).toUpperCase() || null
      if (currency && !/^[A-Z]{3}$/.test(currency)) return void errors.push({ row: n, message: 'currency must be a 3-letter code' })
      rows.push({ rowNumber: n, row: { kind, key: variantId ? `variant:${variantId}` : `sku:${sku!.toLowerCase()}`, sku, variantId, price, compareAtPrice: cap, currency, ambiguous: false } })
    } else if (kind === 'sku_mapping') {
      const sku = clean(raw.sku)
      if (!sku) return void errors.push({ row: n, message: 'sku is empty' })
      if (sku.length > 255) return void errors.push({ row: n, message: 'sku is longer than 255 characters' })
      const variantId = clean(raw.variant_id) ? variantGid(clean(raw.variant_id)) : null
      if (clean(raw.variant_id) && !variantId) return void errors.push({ row: n, message: 'variant_id is not a Shopify variant id' })
      const barcode = clean(raw.barcode) || null
      const handle = clean(raw.product_handle).toLowerCase() || null
      const title = clean(raw.variant_title) || null
      const matchBy = variantId ? 'variant_id' : barcode ? 'barcode' : handle && title ? 'handle_option' : null
      if (!matchBy) return void errors.push({ row: n, message: 'needs variant_id, barcode, or product_handle + variant_title' })
      const key = matchBy === 'variant_id' ? `variant:${variantId}` : matchBy === 'barcode' ? `barcode:${barcode}` : `handle:${handle}|${title!.toLowerCase()}`
      rows.push({ rowNumber: n, row: { kind, key, matchBy, variantId, barcode, handle, variantTitle: title, sku, ambiguous: false, duplicateTarget: false } })
    } else {
      const productId = clean(raw.product_id) ? productGid(clean(raw.product_id)) : null
      if (clean(raw.product_id) && !productId) return void errors.push({ row: n, message: 'product_id is not a Shopify product id' })
      const handle = clean(raw.product_handle).toLowerCase() || null
      if (!productId && !handle) return void errors.push({ row: n, message: 'needs product_id or product_handle' })
      const p = clean(raw.published).toLowerCase()
      const published = ['yes', 'y', 'true', '1'].includes(p) ? true : ['no', 'n', 'false', '0'].includes(p) ? false : null
      if (published === null) return void errors.push({ row: n, message: 'published must be yes or no' })
      rows.push({ rowNumber: n, row: { kind, key: productId ? `product:${productId}` : `handle:${handle}`, productId, handle, published, ambiguous: false } })
    }
  })

  // ambiguity: the same key twice (with any values) is never resolved by picking one
  const byKey = new Map<string, number>()
  for (const { row } of rows) byKey.set(row.key, (byKey.get(row.key) ?? 0) + 1)
  let ambiguousKeys = 0
  for (const [, c] of byKey) if (c > 1) ambiguousKeys++
  for (const { row } of rows) if ((byKey.get(row.key) ?? 0) > 1) row.ambiguous = true
  if (kind === 'sku_mapping') {
    const targets = new Map<string, Set<string>>()
    for (const { row } of rows) { const r2 = row as SkuRow; const s = targets.get(r2.sku.toLowerCase()) ?? new Set(); s.add(r2.key); targets.set(r2.sku.toLowerCase(), s) }
    for (const { row } of rows) { const r2 = row as SkuRow; if ((targets.get(r2.sku.toLowerCase())?.size ?? 0) > 1) r2.duplicateTarget = true }
  }
  return { rows, errors, columns, ambiguousKeys }
}

export type SourceRow = { id: string; org_id: string; connection_id: string; kind: ReferenceKind; name: string; version: number; status: string; row_count: number; error_count: number; ambiguous_keys: number; file_sha256: string | null; created_at: string; updated_at: string }

/** Store an upload (service role, after the caller authorised the actor). Same name = new version. */
export async function saveReference(db: Db, input: { orgId: string; connectionId: string; kind: ReferenceKind; name: string; csv: string; actor: string }) {
  const parsed = parseReference(input.kind, input.csv)
  const fatal = parsed.errors.some(e => e.row === 0)
  if (fatal) return { ok: false as const, errors: parsed.errors }
  const sha = createHash('sha256').update(input.csv).digest('hex')
  const name = input.name.trim().slice(0, 120) || `${input.kind} ${new Date().toISOString().slice(0, 10)}`
  const existing = await db.one<SourceRow>(`select * from reference_sources where connection_id = $1 and kind = $2 and lower(name) = lower($3) and status = 'active' for update`, [input.connectionId, input.kind, name])
  if (existing?.file_sha256 === sha) return { ok: true as const, source: existing, unchanged: true, errors: parsed.errors }
  const version = existing ? existing.version + 1 : 1
  const source = existing
    ? (await db.one<SourceRow>(`update reference_sources set version = $2, row_count = $3, error_count = $4, ambiguous_keys = $5, file_sha256 = $6, columns = $7, row_errors = $8, uploaded_by = $9 where id = $1 returning *`,
        [existing.id, version, parsed.rows.length, parsed.errors.length, parsed.ambiguousKeys, sha, JSON.stringify(parsed.columns), JSON.stringify(parsed.errors.slice(0, 200)), input.actor]))!
    : (await db.one<SourceRow>(`insert into reference_sources (org_id, connection_id, kind, name, version, row_count, error_count, ambiguous_keys, file_sha256, columns, row_errors, uploaded_by)
        values ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [input.orgId, input.connectionId, input.kind, name, parsed.rows.length, parsed.errors.length, parsed.ambiguousKeys, sha, JSON.stringify(parsed.columns), JSON.stringify(parsed.errors.slice(0, 200)), input.actor]))!
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const chunk = parsed.rows.slice(i, i + 500)
    const vals: unknown[] = []
    const ph = chunk.map((r, j) => { vals.push(source.id, input.orgId, version, r.rowNumber, r.row.key, JSON.stringify(r.row)); const b = j * 6; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})` })
    await db.query(`insert into reference_rows (source_id, org_id, version, row_number, match_key, data) values ${ph.join(',')}`, vals)
  }
  await audit(db, { orgId: input.orgId, connectionId: input.connectionId, entityType: 'reference', entityId: source.id, event: existing ? 'reference.new_version' : 'reference.uploaded', actor: input.actor,
    detail: { kind: input.kind, name, version, rows: parsed.rows.length, errors: parsed.errors.length, ambiguous_keys: parsed.ambiguousKeys } })
  return { ok: true as const, source, unchanged: false, errors: parsed.errors }
}

export type ReferenceIndex = { id: string; name: string; kind: ReferenceKind; version: number; byKey: Map<string, { rowNumber: number; row: ReferenceRow }[]> }

export async function loadReference(db: Db, sourceId: string): Promise<ReferenceIndex | null> {
  const s = await db.one<SourceRow>(`select * from reference_sources where id = $1 and status = 'active'`, [sourceId])
  if (!s) return null
  const rows = await db.query<{ row_number: number; match_key: string; data: ReferenceRow }>('select row_number, match_key, data from reference_rows where source_id = $1 and version = $2', [s.id, s.version])
  const byKey = new Map<string, { rowNumber: number; row: ReferenceRow }[]>()
  for (const r of rows) { const l = byKey.get(r.match_key) ?? []; l.push({ rowNumber: r.row_number, row: r.data }); byKey.set(r.match_key, l) }
  return { id: s.id, name: s.name, kind: s.kind, version: s.version, byKey }
}

/** In-memory index of a parsed file (previews and tests; stored files load with loadReference). */
export function indexReference(meta: { id: string; name: string; kind: ReferenceKind; version: number }, parsed: ParsedReference): ReferenceIndex {
  const byKey = new Map<string, { rowNumber: number; row: ReferenceRow }[]>()
  for (const r of parsed.rows) { const l = byKey.get(r.row.key) ?? []; l.push(r); byKey.set(r.row.key, l) }
  return { ...meta, byKey }
}

export function templateCsv(kind: ReferenceKind): string {
  const t = REFERENCE_TEMPLATES[kind]
  return `${t.columns.join(',')}\n${t.example.join(',')}\n`
}
