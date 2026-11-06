/**
 * Leasing commission: the math (in whole cents), recording move-ins and payments, building each property's
 * invoice from its move-ins, and the weekly invoiced / collected / owed totals.
 *   percent: value % of one month's rent (50 = half a month), rounded half-up to the cent
 *   flat:    value, as is
 */
import type { Db } from '../db'
import { PackBlocked } from './loop'
import type { CommissionLine } from './templates'

export type CommissionRule = { type: 'percent' | 'flat'; value: number }
const cents = (n: number | string) => Math.round(Number(n) * 100)
export function commissionCents(rule: CommissionRule, monthlyRent: number | string): number {
  if (!(Number(rule.value) >= 0) || !(Number(monthlyRent) >= 0)) throw new PackBlocked('a commission needs a rent and a rule of zero or more')
  if (rule.type === 'flat') return cents(rule.value)
  // rent in cents x percent in hundredths / 10000, rounded half-up
  return Math.floor((cents(monthlyRent) * cents(rule.value) + 5000) / 10000)
}
export const commissionAmount = (rule: CommissionRule, rent: number | string) => commissionCents(rule, rent) / 100
export const ruleLabel = (r: CommissionRule, currency = 'USD') => (r.type === 'flat' ? `flat fee ${Number(r.value).toFixed(2)} ${currency}` : `${Number(r.value).toString()}% of one month's rent`)

export type PropertyRow = { id: string; org_id: string; company_id: string | null; name: string; address: string | null; billing_email: string | null; commission_type: 'percent' | 'flat'; commission_value: string; payment_terms_days: number }
export type PlacementRow = { id: string; org_id: string; property_id: string | null; lead_id: string | null; tenant_name: string; tenant_email: string | null; unit: string; move_in_date: string; monthly_rent: string; commission_type: 'percent' | 'flat'; commission_value: string; commission_amount: string; status: string; invoice_id: string | null }
export type InvoiceRow = { id: string; org_id: string; property_id: string | null; number: string; issued_on: string; due_date: string; currency: string; total: string; paid_amount: string; status: string; bill_to: string | null; sent_at: string | null; reminders: number; last_reminder_at: string | null; escalated_at: string | null; paid_at: string | null; lines: CommissionLine[] }

/** Record a move-in. The commission rule is copied from the property (an override may be given) and the amount fixed now. */
export async function recordPlacement(db: Db, orgId: string, p: { propertyId: string; tenantName: string; tenantEmail?: string | null; unit: string; moveInDate: string; monthlyRent: number; leadId?: string | null; rule?: CommissionRule }) {
  const prop = await db.one<PropertyRow>('select * from leasing_properties where id = $1 and org_id = $2', [p.propertyId, orgId])
  if (!prop) throw new PackBlocked('that property is not in this organization')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.moveInDate)) throw new PackBlocked('the move-in date must be a date (YYYY-MM-DD)')
  if (!p.tenantName.trim() || !p.unit.trim()) throw new PackBlocked('a move-in needs the tenant and the unit')
  if (!(p.monthlyRent > 0)) throw new PackBlocked('a move-in needs the monthly rent')
  const rule = p.rule ?? { type: prop.commission_type, value: Number(prop.commission_value) }
  const amount = commissionAmount(rule, p.monthlyRent)
  return (await db.one<PlacementRow>(`insert into leasing_placements (org_id, property_id, lead_id, tenant_name, tenant_email, unit, move_in_date, monthly_rent, commission_type, commission_value, commission_amount)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`, [orgId, prop.id, p.leadId ?? null, p.tenantName.trim().slice(0, 160), p.tenantEmail ?? null, p.unit.trim().slice(0, 40), p.moveInDate, p.monthlyRent, rule.type, rule.value, amount]))!
}

/** The lines and total of one property's next invoice: every moved-in placement not yet billed, oldest move-in first. */
export async function invoiceDraftFor(db: Db, orgId: string, propertyId: string): Promise<{ placements: PlacementRow[]; lines: CommissionLine[]; totalCents: number }> {
  const placements = await db.query<PlacementRow>(`select *, to_char(move_in_date, 'YYYY-MM-DD') as move_in_date from leasing_placements x where org_id = $1 and property_id = $2 and status = 'moved_in' and invoice_id is null order by x.move_in_date, x.created_at, x.id`, [orgId, propertyId])
  const lines = placements.map(p => ({ tenant: p.tenant_name, unit: p.unit, moveIn: p.move_in_date, rent: Number(p.monthly_rent), rule: ruleLabel({ type: p.commission_type, value: Number(p.commission_value) }), commission: Number(p.commission_amount) }))
  return { placements, lines, totalCents: lines.reduce((a, l) => a + cents(l.commission), 0) }
}

export async function nextInvoiceNumber(db: Db, orgId: string): Promise<string> {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`leasing-invoice:${orgId}`])
  const r = await db.one<{ n: number }>(`select count(*)::int + 1 as n from leasing_invoices where org_id = $1`, [orgId])
  return `CI-${String(r?.n ?? 1).padStart(4, '0')}`
}

/** A payment against a commission invoice (partial or full). Idempotent on externalId when given. */
export async function recordPayment(db: Db, orgId: string, p: { invoiceId?: string; invoiceNumber?: string; amount: number; receivedOn: string; externalId?: string | null; note?: string | null }) {
  if (!(p.amount > 0)) throw new PackBlocked('a payment needs an amount above zero')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.receivedOn)) throw new PackBlocked('the payment date must be a date (YYYY-MM-DD)')
  const inv = await db.one<InvoiceRow>(`select * from leasing_invoices where org_id = $1 and (id::text = $2 or number = $3) for update`, [orgId, p.invoiceId ?? '', p.invoiceNumber ?? ''])
  if (!inv) throw new PackBlocked('that invoice is not in this organization')
  if (inv.status === 'void' || inv.status === 'draft') throw new PackBlocked(`invoice ${inv.number} is ${inv.status}`)
  if (p.externalId && await db.one('select 1 from leasing_payments where org_id = $1 and external_id = $2', [orgId, p.externalId])) return { invoice: inv, repeat: true, overpaid: 0, paymentId: null }
  const open = cents(inv.total) - cents(inv.paid_amount)
  if (open <= 0) return { invoice: inv, repeat: true, overpaid: cents(p.amount) / 100, paymentId: null }
  const pay = (await db.one<{ id: string }>(`insert into leasing_payments (org_id, invoice_id, amount, received_on, note, external_id) values ($1,$2,$3,$4,$5,$6) returning id`, [orgId, inv.id, p.amount, p.receivedOn, p.note ?? null, p.externalId ?? null]))!
  const paid = cents(inv.paid_amount) + cents(p.amount)
  const full = paid >= cents(inv.total)
  const r = (await db.one<InvoiceRow>(`update leasing_invoices set paid_amount = $2, status = $3, paid_at = case when $3 = 'paid' then now() else paid_at end where id = $1 returning *`, [inv.id, paid / 100, full ? 'paid' : 'partial']))!
  if (full) await db.query(`update leasing_placements set status = 'paid' where invoice_id = $1 and status = 'invoiced'`, [inv.id])
  return { invoice: r, repeat: false, overpaid: Math.max(0, paid - cents(inv.total)) / 100, paymentId: pay.id }
}

export type WeeklyTotals = { from: string; to: string; invoiced: number; collected: number; owed: number; invoices: number; payments: number; overdue: number }
/** [from, to) by calendar day. Owed is everything still open on sent and part-paid invoices, as of `to`. */
export async function weeklyTotals(db: Db, orgId: string, from: string, to: string): Promise<WeeklyTotals> {
  const r = await db.one<{ invoiced: string; invoices: number; collected: string; payments: number; owed: string; overdue: string }>(`select
      (select coalesce(sum(total), 0) from leasing_invoices where org_id = $1 and status <> 'void' and status <> 'draft' and issued_on >= $2::date and issued_on < $3::date) as invoiced,
      (select count(*)::int from leasing_invoices where org_id = $1 and status <> 'void' and status <> 'draft' and issued_on >= $2::date and issued_on < $3::date) as invoices,
      (select coalesce(sum(amount), 0) from leasing_payments where org_id = $1 and received_on >= $2::date and received_on < $3::date) as collected,
      (select count(*)::int from leasing_payments where org_id = $1 and received_on >= $2::date and received_on < $3::date) as payments,
      (select coalesce(sum(total - paid_amount), 0) from leasing_invoices where org_id = $1 and status in ('sent','partial')) as owed,
      (select coalesce(sum(total - paid_amount), 0) from leasing_invoices where org_id = $1 and status in ('sent','partial') and due_date < $3::date) as overdue`, [orgId, from, to])
  return { from, to, invoiced: Number(r?.invoiced ?? 0), collected: Number(r?.collected ?? 0), owed: Number(r?.owed ?? 0), invoices: r?.invoices ?? 0, payments: r?.payments ?? 0, overdue: Number(r?.overdue ?? 0) }
}

/** Undo a recorded payment: the payment row goes, and the invoice's paid amount and status are recomputed from what is left. */
export async function undoPayment(db: Db, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const id = typeof payload.paymentId === 'string' ? payload.paymentId : ''
  const p = await db.one<{ invoice_id: string; org_id: string }>('delete from leasing_payments where id::text = $1 returning invoice_id, org_id', [id])
  if (!p) return { ok: false, detail: 'that payment is no longer recorded' }
  const r = (await db.one<{ number: string; status: string }>(`update leasing_invoices i set paid_amount = coalesce((select sum(amount) from leasing_payments where invoice_id = i.id), 0),
      status = case when coalesce((select sum(amount) from leasing_payments where invoice_id = i.id), 0) >= i.total then 'paid' when coalesce((select sum(amount) from leasing_payments where invoice_id = i.id), 0) > 0 then 'partial' else 'sent' end,
      paid_at = case when coalesce((select sum(amount) from leasing_payments where invoice_id = i.id), 0) >= i.total then paid_at else null end
    where id = $1 returning number, status`, [p.invoice_id]))!
  if (r.status !== 'paid') await db.query(`update leasing_placements set status = 'invoiced' where invoice_id = $1 and status = 'paid'`, [p.invoice_id])
  return { ok: true, detail: `invoice ${r.number} is ${r.status} again` }
}
