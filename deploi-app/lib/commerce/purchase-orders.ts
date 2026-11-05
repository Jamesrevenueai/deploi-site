/**
 * Purchase orders. Shopify and WooCommerce have no purchase-order API, so a PO exists in Deploi only when the
 * merchant imports it (a CSV they upload) or approves one (the reorder of a remainder, lib/commerce/supplier-coordinator.ts).
 * Deploi never invents a PO, a supplier, a quantity or a price.
 *
 * Import rules:
 *  - strict validation, row by row; a PO with any bad row is not imported at all (the others are), and every
 *    error names its row and column;
 *  - idempotent: the same PO number with the same rows (content hash) is a no-op; changed rows update the PO
 *    (the merchant's file is the authority for what was ordered, confirmed and received);
 *  - SKUs are matched against the store only when exactly one store record has that SKU; ambiguous or unknown
 *    SKUs are recorded as such and never guessed;
 *  - file content is data: nothing in it can choose a recipient other than the PO's own supplier email,
 *    and nothing in it changes what an agent may do.
 */
import Papa from 'papaparse'
import { createHash } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { canonicalJson } from '../engine/hash'
import { getConnector } from '../engine/registry'
import { loadConnection } from '../engine/scan'
import type { ResourceRecord } from '../engine/types'
import '../connectors'

export const PO_STATUSES = ['draft', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled'] as const
export type PoStatus = (typeof PO_STATUSES)[number]
export type MatchStatus = 'matched' | 'unmatched' | 'ambiguous' | 'no_store'

export type PoLine = {
  id: string; po_id: string; line_no: number; sku: string; description: string | null; variant_ref: string | null; match_status: MatchStatus
  qty_ordered: number; qty_confirmed: number | null; qty_received: number; unit_price_ordered: number; unit_price_original: number | null; unit_price_confirmed: number | null; cancelled: boolean
}
export type PurchaseOrder = {
  id: string; org_id: string; connection_id: string | null; po_number: string; supplier_name: string | null; supplier_email: string; status: PoStatus
  ordered_at: string; sent_at: string | null; expected_at: string | null; confirmed_expected_at: string | null; confirmed_at: string | null
  currency: string; subtotal: number; source: 'import' | 'manual'; source_file: string | null; content_hash: string | null; parent_po_id: string | null
  created_at: string; updated_at: string; lines: PoLine[]
}

const PO_COLS = `id, org_id, connection_id, po_number, supplier_name, supplier_email, status, to_char(ordered_at, 'YYYY-MM-DD') as ordered_at, sent_at,
  to_char(expected_at, 'YYYY-MM-DD') as expected_at, to_char(confirmed_expected_at, 'YYYY-MM-DD') as confirmed_expected_at, confirmed_at, currency, subtotal::float8 as subtotal,
  source, source_file, content_hash, parent_po_id, created_at, updated_at`
const LINE_COLS = `id, po_id, line_no, sku, description, variant_ref, match_status, qty_ordered, qty_confirmed, qty_received, unit_price_ordered::float8 as unit_price_ordered,
  unit_price_original::float8 as unit_price_original, unit_price_confirmed::float8 as unit_price_confirmed, cancelled`

/** One PO with its lines (any Db: service role, or a user's RLS view). */
export async function loadPo(db: Db, poId: string, orgId?: string): Promise<PurchaseOrder | null> {
  const po = await db.one<Omit<PurchaseOrder, 'lines'>>(`select ${PO_COLS} from purchase_orders where id = $1 ${orgId ? 'and org_id = $2' : ''}`, orgId ? [poId, orgId] : [poId])
  if (!po) return null
  const lines = await db.query<PoLine>(`select ${LINE_COLS} from purchase_order_lines where po_id = $1 order by line_no`, [po.id])
  return { ...po, lines }
}

export async function listPos(db: Db, orgId: string, opts: { limit?: number } = {}): Promise<PurchaseOrder[]> {
  const pos = await db.query<Omit<PurchaseOrder, 'lines'>>(`select ${PO_COLS} from purchase_orders where org_id = $1 order by updated_at desc limit $2`, [orgId, Math.min(Math.max(opts.limit ?? 100, 1), 500)])
  if (!pos.length) return []
  const lines = await db.query<PoLine>(`select ${LINE_COLS} from purchase_order_lines where po_id = any($1::uuid[]) order by po_id, line_no`, [pos.map(p => p.id)])
  return pos.map(p => ({ ...p, lines: lines.filter(l => l.po_id === p.id) }))
}

/** Lines still expected: not cancelled. */
export const openLines = (po: Pick<PurchaseOrder, 'lines'>) => po.lines.filter(l => !l.cancelled)
export const fullyReceived = (po: Pick<PurchaseOrder, 'lines'>) => openLines(po).length > 0 && openLines(po).every(l => l.qty_received >= l.qty_ordered)

// ---------------------------------------------------------------- CSV import

export const PO_CSV_COLUMNS = {
  required: ['po_number', 'supplier_email', 'ordered_at', 'sku', 'qty_ordered', 'unit_price'],
  optional: ['supplier_name', 'status', 'sent_at', 'expected_at', 'confirmed_expected_at', 'currency', 'description', 'qty_confirmed', 'unit_price_confirmed', 'qty_received'],
} as const
export const PO_CSV_TEMPLATE = 'po_number,supplier_name,supplier_email,ordered_at,sent_at,expected_at,currency,sku,description,qty_ordered,unit_price,qty_confirmed,unit_price_confirmed,qty_received\r\n'
const MAX_BYTES = 2_000_000, MAX_ROWS = 5000, MAX_LINES_PER_PO = 500

export type ImportError = { row: number | null; column?: string; poNumber?: string; message: string }
export type ImportResult = {
  ok: boolean; fileHash: string; created: string[]; updated: string[]; unchanged: string[]; rejected: string[]; errors: ImportError[]
  poIds: string[]; matches: { matched: number; unmatched: number; ambiguous: number; noStore: number }
}

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const PO_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function isoDate(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) && Number(m[1]) >= 2000 && Number(m[1]) <= 2100 ? m[0] : null
}
const wholeNumber = (v: string, min: number) => (/^\d{1,8}$/.test(v.trim()) && Number(v) >= min ? Number(v) : null)
const money = (v: string) => (/^\d{1,10}(\.\d{1,4})?$/.test(v.trim()) ? Number(v) : null)

type ParsedLine = { sku: string; description: string | null; qtyOrdered: number; unitPrice: number; qtyConfirmed: number | null; unitPriceConfirmed: number | null; qtyReceived: number | null }
type ParsedPo = {
  poNumber: string; supplierName: string | null; supplierEmail: string; status: PoStatus | null; orderedAt: string; sentAt: string | null
  expectedAt: string | null; confirmedExpectedAt: string | null; currency: string; lines: ParsedLine[]; rows: number[]
}

/** Parse and validate a PO file. No database: every problem is returned with its row (the header is row 1). */
export function parsePoCsv(csv: string): { pos: ParsedPo[]; errors: ImportError[]; rejected: string[] } {
  const errors: ImportError[] = []
  if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) return { pos: [], errors: [{ row: null, message: 'the file is larger than 2 MB' }], rejected: [] }
  const r = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, '_') })
  const header = r.meta.fields ?? []
  const missing = PO_CSV_COLUMNS.required.filter(c => !header.includes(c))
  if (missing.length) return { pos: [], errors: [{ row: 1, message: `missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` }], rejected: [] }
  if (r.data.length > MAX_ROWS) return { pos: [], errors: [{ row: null, message: `the file has more than ${MAX_ROWS} rows` }], rejected: [] }
  for (const e of r.errors.slice(0, 20)) errors.push({ row: typeof e.row === 'number' ? e.row + 2 : null, message: `could not read the row: ${e.message}` })
  const byNumber = new Map<string, ParsedPo>()
  const bad = new Set<string>()
  r.data.forEach((raw, i) => {
    const row = i + 2
    const v = (k: string) => String(raw[k] ?? '').trim()
    const err = (column: string, message: string, poNumber?: string) => errors.push({ row, column, ...(poNumber ? { poNumber } : {}), message })
    const poNumber = v('po_number')
    if (!PO_NUMBER.test(poNumber)) { err('po_number', poNumber ? 'po_number may use letters, digits and . _ / # - (at most 64 characters)' : 'po_number is required'); return }
    const before = errors.length
    const email = v('supplier_email').toLowerCase()
    if (!EMAIL.test(email) || email.length > 254) err('supplier_email', 'supplier_email is not a valid email address', poNumber)
    const orderedAt = isoDate(v('ordered_at'))
    if (!orderedAt) err('ordered_at', 'ordered_at must be a date like 2026-11-05', poNumber)
    const date = (k: string) => { const s = v(k); if (!s) return null; const d = isoDate(s); if (!d) err(k, `${k} must be a date like 2026-11-05`, poNumber); return d }
    const expectedAt = date('expected_at'), confirmedExpectedAt = date('confirmed_expected_at')
    const sentRaw = v('sent_at')
    let sentAt: string | null = null
    if (sentRaw) {
      const d = isoDate(sentRaw) ?? (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(sentRaw) && !Number.isNaN(new Date(sentRaw).getTime()) ? new Date(sentRaw).toISOString() : null)
      if (!d) err('sent_at', 'sent_at must be a date like 2026-11-05 (or a full ISO time)', poNumber)
      else sentAt = d.length === 10 ? `${d}T00:00:00.000Z` : d
    }
    const status = v('status').toLowerCase().replace(/\s+/g, '_') || null
    if (status && !PO_STATUSES.includes(status as PoStatus)) err('status', `status must be one of ${PO_STATUSES.join(', ')}`, poNumber)
    const currency = (v('currency') || 'USD').toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) err('currency', 'currency must be a three-letter code like USD', poNumber)
    const supplierName = v('supplier_name') || null
    if (supplierName && (supplierName.length > 200 || CONTROL.test(supplierName))) err('supplier_name', 'supplier_name is too long or has control characters', poNumber)
    const sku = v('sku')
    if (!sku || sku.length > 120 || CONTROL.test(sku)) err('sku', 'sku is required (at most 120 characters)', poNumber)
    const description = v('description') || null
    if (description && (description.length > 300 || CONTROL.test(description))) err('description', 'description is at most 300 characters', poNumber)
    const qtyOrdered = wholeNumber(v('qty_ordered'), 1)
    if (qtyOrdered === null) err('qty_ordered', 'qty_ordered must be a whole number of at least 1', poNumber)
    const unitPrice = money(v('unit_price'))
    if (unitPrice === null) err('unit_price', 'unit_price must be a number like 12.50 (no currency sign)', poNumber)
    const opt = <T,>(k: string, f: (s: string) => T | null, msg: string): T | null => { const s = v(k); if (!s) return null; const x = f(s); if (x === null) err(k, msg, poNumber); return x }
    const qtyConfirmed = opt('qty_confirmed', s => wholeNumber(s, 0), 'qty_confirmed must be a whole number')
    const unitPriceConfirmed = opt('unit_price_confirmed', money, 'unit_price_confirmed must be a number like 12.50')
    const qtyReceived = opt('qty_received', s => wholeNumber(s, 0), 'qty_received must be a whole number')
    if (errors.length > before) { bad.add(poNumber); return }
    const head = { supplierName, supplierEmail: email, status: status as PoStatus | null, orderedAt: orderedAt!, sentAt, expectedAt, confirmedExpectedAt, currency }
    const po = byNumber.get(poNumber)
    if (!po) { byNumber.set(poNumber, { poNumber, ...head, lines: [], rows: [] }); }
    const p = byNumber.get(poNumber)!
    if (po) {
      // every row of one PO must say the same thing about the PO itself
      for (const [k, label] of [['supplierEmail', 'supplier_email'], ['supplierName', 'supplier_name'], ['orderedAt', 'ordered_at'], ['expectedAt', 'expected_at'], ['confirmedExpectedAt', 'confirmed_expected_at'], ['currency', 'currency'], ['status', 'status'], ['sentAt', 'sent_at']] as const) {
        if ((p as Record<string, unknown>)[k] !== (head as Record<string, unknown>)[k]) { err(label, `${label} differs from an earlier row of PO ${poNumber}`, poNumber); bad.add(poNumber) }
      }
      if (p.lines.some(l => l.sku.toLowerCase() === sku.toLowerCase())) { err('sku', `SKU ${sku} is listed twice on PO ${poNumber}`, poNumber); bad.add(poNumber) }
    }
    if (bad.has(poNumber)) return
    if (p.lines.length >= MAX_LINES_PER_PO) { err('sku', `PO ${poNumber} has more than ${MAX_LINES_PER_PO} lines`, poNumber); bad.add(poNumber); return }
    p.lines.push({ sku, description, qtyOrdered: qtyOrdered!, unitPrice: unitPrice!, qtyConfirmed, unitPriceConfirmed, qtyReceived })
    p.rows.push(row)
  })
  const pos = [...byNumber.values()].filter(p => !bad.has(p.poNumber))
  return { pos, errors, rejected: [...bad] }
}

function deriveStatus(p: ParsedPo): PoStatus {
  if (p.status) return p.status
  const received = p.lines.map(l => l.qtyReceived ?? 0)
  if (p.lines.every((l, i) => received[i] >= l.qtyOrdered)) return 'received'
  if (received.some(n => n > 0)) return 'partially_received'
  if (p.lines.every(l => l.qtyConfirmed !== null)) return 'confirmed'
  return 'sent'
}

const poHash = (p: ParsedPo) => sha(canonicalJson({ ...p, rows: undefined }))

/**
 * Match SKUs to the store: a SKU matches only when exactly one store record carries it (case-insensitive).
 * Returns sku(lowercase) -> match. Reads the store through its connector (read only).
 */
export async function matchSkus(connectionId: string | null, orgId: string, skus: string[]): Promise<{ map: Map<string, { status: MatchStatus; ref: string | null }>; note: string | null }> {
  const map = new Map<string, { status: MatchStatus; ref: string | null }>()
  const wanted = [...new Set(skus.map(s => s.toLowerCase()))]
  const none = (status: MatchStatus) => { for (const s of wanted) map.set(s, { status, ref: null }) }
  if (!connectionId) { none('no_store'); return { map, note: null } }
  const conn = await admin(db => loadConnection(db, connectionId))
  if (!conn || conn.org_id !== orgId) throw new EngineError('not_found', 'store not found')
  if (conn.status !== 'active') { none('no_store'); return { map, note: `the store connection is ${conn.status}; SKUs were not matched` } }
  let records: ResourceRecord[] = []
  try {
    const connector = getConnector(conn.platform)
    if (!connector.operational) { none('no_store'); return { map, note: `${conn.platform} is not operational; SKUs were not matched` } }
    if (connector.findResources) records = await connector.findResources(conn, { skus: [...new Set(skus)], barcodes: [], handles: [] })
    else for await (const page of connector.listResources(conn)) records.push(...page)
  } catch (e) {
    none('no_store')
    return { map, note: `could not read the store to match SKUs (${(e as Error).message.slice(0, 120)}); nothing was guessed` }
  }
  for (const s of wanted) {
    const hits = records.filter(r => typeof r.sku === 'string' && (r.sku as string).trim().toLowerCase() === s)
    const refs = [...new Set(hits.map(r => String(r.variantId ?? r.resourceId)))]
    map.set(s, refs.length === 1 ? { status: 'matched', ref: refs[0] } : { status: refs.length ? 'ambiguous' : 'unmatched', ref: null })
  }
  return { map, note: null }
}

/**
 * Import a PO file for an organization (service role; the caller has checked the actor). `connectionId`, when
 * given, is the store whose SKUs the lines are matched against and must belong to the organization.
 */
export async function importPurchaseOrders(input: { orgId: string; connectionId?: string | null; csv: string; actor: string; now?: Date }): Promise<ImportResult> {
  const fileHash = sha(input.csv)
  const parsed = parsePoCsv(input.csv)
  const result: ImportResult = { ok: false, fileHash, created: [], updated: [], unchanged: [], rejected: [...parsed.rejected], errors: [...parsed.errors], poIds: [], matches: { matched: 0, unmatched: 0, ambiguous: 0, noStore: 0 } }
  if (!parsed.pos.length) { result.ok = !result.errors.length; return result }
  const { map, note } = await matchSkus(input.connectionId ?? null, input.orgId, parsed.pos.flatMap(p => p.lines.map(l => l.sku)))
  if (note) result.errors.push({ row: null, message: note })
  await admin(async db => {
    for (const p of parsed.pos) {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`po:${input.orgId}:${p.poNumber}`])
      const hash = poHash(p)
      const existing = await db.one<{ id: string; content_hash: string | null; source: string }>('select id, content_hash, source from purchase_orders where org_id = $1 and po_number = $2 for update', [input.orgId, p.poNumber])
      if (existing && existing.content_hash === hash) { result.unchanged.push(p.poNumber); result.poIds.push(existing.id); continue }
      if (existing && existing.source !== 'import') {
        result.rejected.push(p.poNumber)
        result.errors.push({ row: p.rows[0], column: 'po_number', poNumber: p.poNumber, message: `PO ${p.poNumber} was created in Deploi (an approved reorder), not imported; give the imported order its own number` })
        continue
      }
      if (existing) {
        const have = await db.query<{ sku: string }>('select sku from purchase_order_lines where po_id = $1', [existing.id])
        const gone = have.filter(h => !p.lines.some(l => l.sku.toLowerCase() === h.sku.toLowerCase()))
        if (gone.length) {
          result.rejected.push(p.poNumber)
          result.errors.push({ row: p.rows[0], column: 'sku', poNumber: p.poNumber, message: `PO ${p.poNumber} no longer lists ${gone.map(g => g.sku).join(', ')}; Deploi does not remove lines on import (cancel them through the case or set the PO status)` })
          continue
        }
      }
      const status = deriveStatus(p)
      const subtotal = p.lines.reduce((s, l) => s + l.qtyOrdered * l.unitPrice, 0)
      const vals = [p.supplierName, p.supplierEmail, status, p.orderedAt, p.sentAt, p.expectedAt, p.confirmedExpectedAt, p.currency, subtotal.toFixed(4), fileHash, hash, input.connectionId ?? null]
      const po = existing
        ? (await db.one<{ id: string }>(`update purchase_orders set supplier_name = $2, supplier_email = $3, status = $4, ordered_at = $5, sent_at = $6, expected_at = $7, confirmed_expected_at = $8, currency = $9,
             subtotal = $10, source_file = $11, content_hash = $12, connection_id = coalesce($13, connection_id), confirmed_at = case when $4 in ('confirmed','partially_received','received') then coalesce(confirmed_at, now()) else confirmed_at end
             where id = $1 returning id`, [existing.id, ...vals]))!
        : (await db.one<{ id: string }>(`insert into purchase_orders (supplier_name, supplier_email, status, ordered_at, sent_at, expected_at, confirmed_expected_at, currency, subtotal, source_file, content_hash, connection_id,
             org_id, po_number, source, created_by, confirmed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'import',$15, case when $3 in ('confirmed','partially_received','received') then now() end) returning id`,
            [...vals, input.orgId, p.poNumber, input.actor]))!
      let lineNo = existing ? Number((await db.one<{ n: number }>('select coalesce(max(line_no), 0)::int as n from purchase_order_lines where po_id = $1', [po.id]))!.n) : 0
      for (const l of p.lines) {
        const m = map.get(l.sku.toLowerCase()) ?? { status: 'no_store' as MatchStatus, ref: null }
        result.matches[m.status === 'no_store' ? 'noStore' : m.status]++
        const upd = await db.query(`update purchase_order_lines set description = $3, qty_ordered = $4, unit_price_ordered = $5, unit_price_original = $5, qty_confirmed = $6, unit_price_confirmed = $7,
            qty_received = coalesce($8, qty_received), variant_ref = $9, match_status = $10 where po_id = $1 and lower(sku) = lower($2) returning id`,
          [po.id, l.sku, l.description, l.qtyOrdered, l.unitPrice, l.qtyConfirmed, l.unitPriceConfirmed, l.qtyReceived, m.ref, m.status])
        if (!upd.length) await db.query(`insert into purchase_order_lines (po_id, org_id, line_no, sku, description, qty_ordered, unit_price_ordered, unit_price_original, qty_confirmed, unit_price_confirmed, qty_received, variant_ref, match_status)
            values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,coalesce($10, 0),$11,$12)`, [po.id, input.orgId, ++lineNo, l.sku, l.description, l.qtyOrdered, l.unitPrice, l.qtyConfirmed, l.unitPriceConfirmed, l.qtyReceived, m.ref, m.status])
      }
      await audit(db, { orgId: input.orgId, connectionId: input.connectionId ?? null, entityType: 'purchase_order', entityId: po.id, event: existing ? 'purchase_order.reimported' : 'purchase_order.imported', actor: input.actor,
        detail: { po_number: p.poNumber, lines: p.lines.length, file_hash: fileHash, content_hash: hash, status } })
      ;(existing ? result.updated : result.created).push(p.poNumber)
      result.poIds.push(po.id)
    }
  })
  result.ok = result.rejected.length === 0 && !result.errors.length
  return result
}

/** The merchant imports a file. The store (when given) must be one of their own. */
export async function importPurchaseOrdersAs(actor: Actor, input: { csv: string; connectionId?: string | null }): Promise<ImportResult> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not import purchase orders')
  let connectionId: string | null = null
  if (input.connectionId) {
    const conn = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from store_connections where id = $1', [input.connectionId]))
    if (!conn) throw new EngineError('not_found', 'store not found')
    assertMerchant(actor, conn.org_id)
    connectionId = conn.id
  }
  return importPurchaseOrders({ orgId: actor.orgId, connectionId, csv: input.csv, actor: actor.label })
}

/**
 * Record goods received (an authorized write by the merchant): quantities per SKU, added to what was already
 * received. Updates the PO status and re-checks the open cases on it.
 */
export async function recordReceipt(db: Db, input: { orgId: string; poId: string; lines: { sku: string; qty: number }[]; actor: string }): Promise<PurchaseOrder> {
  const po = await db.one<{ id: string; status: string }>('select id, status from purchase_orders where id = $1 and org_id = $2 for update', [input.poId, input.orgId])
  if (!po) throw new EngineError('not_found', 'purchase order not found')
  if (po.status === 'cancelled' || po.status === 'draft') throw new EngineError('invalid_input', `the purchase order is ${po.status}`)
  if (!input.lines.length || input.lines.length > MAX_LINES_PER_PO) throw new EngineError('invalid_input', 'list the SKUs received')
  const lines = await db.query<{ id: string; sku: string; qty_received: number; cancelled: boolean }>('select id, sku, qty_received, cancelled from purchase_order_lines where po_id = $1 for update', [po.id])
  const changes: { sku: string; from: number; to: number }[] = []
  for (const r of input.lines) {
    const l = lines.find(x => x.sku.toLowerCase() === String(r.sku).trim().toLowerCase())
    if (!l) throw new EngineError('invalid_input', `SKU ${String(r.sku).slice(0, 60)} is not on this purchase order`)
    if (!Number.isInteger(r.qty) || r.qty < 1 || r.qty > 1_000_000) throw new EngineError('invalid_input', 'received quantities are whole numbers of at least 1')
    changes.push({ sku: l.sku, from: l.qty_received, to: l.qty_received + r.qty })
    await db.query('update purchase_order_lines set qty_received = qty_received + $2 where id = $1', [l.id, r.qty])
  }
  await refreshStatus(db, po.id)
  await audit(db, { orgId: input.orgId, entityType: 'purchase_order', entityId: po.id, event: 'purchase_order.received', actor: input.actor, detail: { changes } })
  return (await loadPo(db, po.id))!
}

/** Status and subtotal from the lines (received / partially received), after any write to them. */
export async function refreshStatus(db: Db, poId: string) {
  const po = (await loadPo(db, poId))!
  const open = openLines(po)
  let status: PoStatus = po.status
  if (po.status !== 'cancelled' && po.status !== 'draft') {
    if (!open.length) status = 'cancelled'
    else if (open.every(l => l.qty_received >= l.qty_ordered)) status = 'received'
    else if (open.some(l => l.qty_received > 0)) status = 'partially_received'
    else if (open.every(l => l.qty_confirmed !== null) && po.status === 'sent') status = 'confirmed'
  }
  const subtotal = open.reduce((s, l) => s + l.qty_ordered * l.unit_price_ordered, 0)
  await db.query(`update purchase_orders set status = $2, subtotal = $3, confirmed_at = case when $2 in ('confirmed','partially_received','received') then coalesce(confirmed_at, now()) else confirmed_at end where id = $1`, [poId, status, subtotal.toFixed(4)])
}
