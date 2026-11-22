/**
 * Supplier exceptions on purchase orders: deterministic rules over the PO record (no model calls, nothing
 * guessed). Each exception becomes one `supplier_exception` case per PO and exception type (lib/cases), with
 * the evidence that shows it and plain verification criteria that the PO record must meet for it to resolve.
 *
 *   missing_confirmation   sent N days ago (default 3) and the supplier has not confirmed every line
 *   quantity_discrepancy   a confirmed or received quantity differs from the quantity ordered (partial shipments included)
 *   delivery_delay         the expected date passed before everything was received, or the supplier's date is later than ordered
 *   price_change           a confirmed unit price differs from the ordered one by more than the tolerance (default 1%)
 */
import type { Db } from '../db'
import type { DiscoveryFinding } from '../discovery/registry'
import type { Evidence, Priority } from '../cases'
import { listPos, openLines, type PurchaseOrder } from './purchase-orders'

export const SUPPLIER_EXCEPTION_KIND = 'supplier_exception'
export const EXCEPTION_TYPES = ['missing_confirmation', 'quantity_discrepancy', 'delivery_delay', 'price_change'] as const
export type ExceptionType = (typeof EXCEPTION_TYPES)[number]
export const EXCEPTION_LABEL: Record<ExceptionType, string> = {
  missing_confirmation: 'No confirmation from the supplier',
  quantity_discrepancy: 'Quantities differ from the order',
  delivery_delay: 'Delivery is late',
  price_change: 'Price differs from the order',
}

export type ExceptionSettings = { confirmationDays: number; priceTolerancePct: number }
export const DEFAULT_EXCEPTION_SETTINGS: ExceptionSettings = { confirmationDays: 3, priceTolerancePct: 1 }

/** The machine rule stored with each case: what the PO record must show (lib/commerce/supplier-coordinator.ts#ruleMet). */
export type ExceptionRule = { type: ExceptionType; poId: string; poNumber: string; requireReceipt: boolean; priceTolerancePct: number }

export type SupplierException = {
  type: ExceptionType; po: PurchaseOrder; dedupeKey: string; title: string; problem: string; whyItMatters: string; priority: Priority
  evidence: Evidence[]; verification: { criteria: string; rule: ExceptionRule }
  lines: { lineId: string; sku: string; detail: Record<string, unknown> }[]
}

const day = (d: Date) => d.toISOString().slice(0, 10)
const money = (n: number, cur: string) => `${n.toFixed(2)} ${cur}`
export const priceDiffers = (ordered: number, confirmed: number, tolerancePct: number) => Math.abs(confirmed - ordered) > Math.max(0.005, (ordered * tolerancePct) / 100)
export const exceptionDedupeKey = (poId: string, type: ExceptionType) => `po:${poId}:${type}`

/** Every exception one PO shows right now. Pure: reads only the PO record given. */
export function poExceptions(po: PurchaseOrder, now: Date, settings: ExceptionSettings = DEFAULT_EXCEPTION_SETTINGS): SupplierException[] {
  if (['draft', 'cancelled', 'received'].includes(po.status)) return []
  const open = openLines(po)
  if (!open.length) return []
  const out: SupplierException[] = []
  const observedAt = now.toISOString()
  const ref = { type: 'purchase_order', id: po.id }
  const src = 'purchase_order'
  const who = po.supplier_name ? `${po.supplier_name} (${po.supplier_email})` : po.supplier_email
  const base = (type: ExceptionType) => ({ type, po, dedupeKey: exceptionDedupeKey(po.id, type) })

  // missing confirmation: sent, N days passed, not every line confirmed
  const sentAt = po.sent_at ? new Date(po.sent_at) : new Date(`${po.ordered_at}T00:00:00Z`)
  const unconfirmed = open.filter(l => l.qty_confirmed === null)
  const waitedDays = Math.floor((now.getTime() - sentAt.getTime()) / 864e5)
  if (po.status === 'sent' && unconfirmed.length && waitedDays >= settings.confirmationDays) {
    out.push({ ...base('missing_confirmation'), priority: waitedDays >= settings.confirmationDays * 2 ? 'high' : 'normal',
      title: `${who} has not confirmed PO ${po.po_number}`,
      problem: `PO ${po.po_number} was sent on ${day(sentAt)} (${waitedDays} days ago). ${unconfirmed.length} of ${open.length} line${open.length === 1 ? '' : 's'} have no confirmed quantity.`,
      whyItMatters: 'Without a confirmation you do not know whether the goods are coming, how many, or when.',
      evidence: [{ label: `PO ${po.po_number}: sent ${day(sentAt)}, ${unconfirmed.length} unconfirmed line(s)`, source: src, observedAt, ref, detail: { sent_at: sentAt.toISOString(), unconfirmed: unconfirmed.map(l => l.sku) } }],
      verification: { criteria: `The PO ${po.po_number} record shows the supplier's confirmation: a confirmed quantity on every open line.`,
        rule: { type: 'missing_confirmation', poId: po.id, poNumber: po.po_number, requireReceipt: false, priceTolerancePct: settings.priceTolerancePct } },
      lines: unconfirmed.map(l => ({ lineId: l.id, sku: l.sku, detail: { ordered: l.qty_ordered } })) })
  }

  // quantity: confirmed or received differs from ordered (a partial shipment counts until the rest arrives or is settled)
  const qty = open.filter(l => (l.qty_confirmed !== null && l.qty_confirmed !== l.qty_ordered) || (l.qty_received > 0 && l.qty_received !== l.qty_ordered))
  if (qty.length) {
    const receipt = qty.some(l => l.qty_received > 0 && l.qty_received !== l.qty_ordered)
    const describe = (l: (typeof qty)[number]) => `${l.sku}: ordered ${l.qty_ordered}${l.qty_confirmed !== null ? `, confirmed ${l.qty_confirmed}` : ''}${l.qty_received > 0 ? `, received ${l.qty_received}` : ''}`
    out.push({ ...base('quantity_discrepancy'), priority: 'high',
      title: `PO ${po.po_number}: ${receipt ? 'partial or different delivery' : 'supplier confirmed different quantities'}`,
      problem: `${qty.length} line${qty.length === 1 ? '' : 's'} of PO ${po.po_number} differ from the order: ${qty.slice(0, 10).map(describe).join('; ')}${qty.length > 10 ? `; and ${qty.length - 10} more` : ''}.`,
      whyItMatters: 'Short or different quantities leave products out of stock or tie up cash in stock you did not plan for.',
      evidence: qty.slice(0, 50).map(l => ({ label: `PO ${po.po_number} ${describe(l)}`, source: src, observedAt, ref, detail: { sku: l.sku, ordered: l.qty_ordered, confirmed: l.qty_confirmed, received: l.qty_received } })),
      verification: { criteria: receipt
          ? `The PO ${po.po_number} record shows every open line received in the agreed quantity (any remainder reordered or cancelled with your approval).`
          : `The PO ${po.po_number} record shows the agreed quantity on every open line: confirmed equals ordered, after the change you approved.`,
        rule: { type: 'quantity_discrepancy', poId: po.id, poNumber: po.po_number, requireReceipt: receipt, priceTolerancePct: settings.priceTolerancePct } },
      lines: qty.map(l => ({ lineId: l.id, sku: l.sku, detail: { ordered: l.qty_ordered, confirmed: l.qty_confirmed, received: l.qty_received } })) })
  }

  // delivery: expected date passed with goods outstanding, or the supplier's date is later than the order's
  const outstanding = open.filter(l => l.qty_received < l.qty_ordered)
  const today = day(now)
  const late = Boolean(po.expected_at && po.expected_at < today && outstanding.length)
  const revised = Boolean(po.expected_at && po.confirmed_expected_at && po.confirmed_expected_at > po.expected_at && outstanding.length)
  if (late || revised) {
    out.push({ ...base('delivery_delay'), priority: late ? 'high' : 'normal',
      title: late ? `PO ${po.po_number} is late (expected ${po.expected_at})` : `PO ${po.po_number}: supplier moved delivery to ${po.confirmed_expected_at}`,
      problem: late
        ? `PO ${po.po_number} was expected on ${po.expected_at}; ${outstanding.length} line${outstanding.length === 1 ? ' is' : 's are'} not fully received.`
        : `PO ${po.po_number} was ordered for ${po.expected_at}; the supplier's date is ${po.confirmed_expected_at}.`,
      whyItMatters: 'A late delivery can leave products out of stock while customers keep ordering.',
      evidence: [{ label: late ? `PO ${po.po_number}: expected ${po.expected_at}, ${outstanding.length} line(s) outstanding on ${today}` : `PO ${po.po_number}: ordered for ${po.expected_at}, supplier date ${po.confirmed_expected_at}`,
        source: src, observedAt, ref, detail: { expected_at: po.expected_at, confirmed_expected_at: po.confirmed_expected_at, outstanding: outstanding.map(l => ({ sku: l.sku, ordered: l.qty_ordered, received: l.qty_received })) } }],
      verification: { criteria: `The PO ${po.po_number} record shows every open line received. An approved new date is monitored: if it passes without the goods recorded as received, the case is escalated.`,
        rule: { type: 'delivery_delay', poId: po.id, poNumber: po.po_number, requireReceipt: true, priceTolerancePct: settings.priceTolerancePct } },
      lines: outstanding.map(l => ({ lineId: l.id, sku: l.sku, detail: { ordered: l.qty_ordered, received: l.qty_received } })) })
  }

  // price: confirmed unit price differs beyond the tolerance
  const price = open.filter(l => l.unit_price_confirmed !== null && priceDiffers(l.unit_price_ordered, l.unit_price_confirmed, settings.priceTolerancePct))
  if (price.length) {
    const describe = (l: (typeof price)[number]) => `${l.sku}: ordered at ${money(l.unit_price_ordered, po.currency)}, confirmed at ${money(l.unit_price_confirmed!, po.currency)}`
    const delta = price.reduce((s, l) => s + (l.unit_price_confirmed! - l.unit_price_ordered) * l.qty_ordered, 0)
    out.push({ ...base('price_change'), priority: delta > 0 ? 'high' : 'normal',
      title: `PO ${po.po_number}: supplier confirmed different prices`,
      problem: `${price.length} line${price.length === 1 ? '' : 's'} of PO ${po.po_number} were confirmed at a different unit price: ${price.slice(0, 10).map(describe).join('; ')}. Difference on the order: ${delta >= 0 ? '+' : ''}${money(delta, po.currency)}.`,
      whyItMatters: 'An unagreed price change changes your margin and what you will be invoiced.',
      evidence: price.slice(0, 50).map(l => ({ label: `PO ${po.po_number} ${describe(l)}`, source: src, observedAt, ref, detail: { sku: l.sku, ordered: l.unit_price_ordered, confirmed: l.unit_price_confirmed, qty: l.qty_ordered } })),
      verification: { criteria: `The PO ${po.po_number} record shows one agreed unit price on every open line (within ${settings.priceTolerancePct}%): the change accepted, or the line cancelled, with your approval.`,
        rule: { type: 'price_change', poId: po.id, poNumber: po.po_number, requireReceipt: false, priceTolerancePct: settings.priceTolerancePct } },
      lines: price.map(l => ({ lineId: l.id, sku: l.sku, detail: { ordered: l.unit_price_ordered, confirmed: l.unit_price_confirmed } })) })
  }
  return out
}

/** Exceptions across an organization's imported POs, as discovery findings (the detector and the coordinator share this). */
export async function findSupplierExceptions(db: Db, orgId: string, now: Date, settings: ExceptionSettings = DEFAULT_EXCEPTION_SETTINGS): Promise<{ pos: number; exceptions: SupplierException[] }> {
  const pos = await listPos(db, orgId, { limit: 500 })
  return { pos: pos.length, exceptions: pos.flatMap(po => poExceptions(po, now, settings)) }
}

export function toFinding(x: SupplierException): DiscoveryFinding {
  return {
    kind: SUPPLIER_EXCEPTION_KIND, dedupeKey: x.dedupeKey, title: x.title, problem: x.problem, whyItMatters: x.whyItMatters, priority: x.priority, evidence: x.evidence,
    records: [{ type: 'purchase_order', id: x.po.id, label: `PO ${x.po.po_number}` }], verification: x.verification,
  }
}
