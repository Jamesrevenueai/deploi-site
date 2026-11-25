/**
 * Action metering (pricing v2, 2026-11-22).
 *
 * An ACTION is one completed step that changes something outside Deploi: an email or text sent, an order, product or
 * inventory updated, an invoice or purchase order drafted or sent, a CRM record written. Watching, scanning and checking
 * are free. Every completed step is written to the `actions` ledger once (unique per organization and dedupe key) with
 * `billable` decided here, and a pointer to its proof.
 *
 * Allowance per calendar month (UTC): the plan's included actions (and, on Office plans, texts) plus whatever the
 * customer's overage cap pays for ($5 per 100 actions, $3 per 100 texts). At the cap, non-urgent work pauses (it is held,
 * never dropped) and the owner is told once that month. Urgent work (a customer who is waiting on a reply) still goes out.
 * Enforced only while BILLING_MODE is test or live, like the rest of billing; with billing off it records but never holds.
 */
import type { Db } from '../db'
import { admin } from '../db'
import { billingMode } from '../billing/config'
import { notifyOwner } from '../notify'
import { CATALOG, isOfficePlan, isStorePlan, officePlan, storePlan, unitsForCap, type PlanKey } from '../pricing'

export type ActionKind = 'action' | 'text'

/** Steps that only look (free). Everything else an agent completes changes something outside Deploi. */
const FREE = /^(read|watch|scan|check|detect|flag|report|recommend|reconcile|summar|monitor|verify|observe|note_|log_)/
const FREE_EXACT = new Set(['flag_late_order', 'flag_oversold', 'flag_fee_anomaly', 'recommend_visibility_fix', 'reconcile_payout', 'weekly_report', 'health_check'])
export const isBillableType = (type: string) => !FREE.test(type) && !FREE_EXACT.has(type)

/** A customer is waiting on this: it still goes out when the cap is reached. */
const URGENT = new Set(['send_text', 'reply_to_lead', 'send_customer_reply', 'send_customer_email'])
export const isUrgentType = (type: string) => URGENT.has(type)

export const monthKey = (d: Date) => `${d.toISOString().slice(0, 7)}-01`
const monthFrom = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
const monthTo = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))

export type RecordedAction = { id: string; billable: boolean; duplicate: boolean }

/** Write one completed step to the ledger (idempotent on dedupeKey). */
export async function recordAction(db: Db, a: { orgId: string; agentKey: string; type: string; proofRef: string | null; dedupeKey: string; kind?: ActionKind; billable?: boolean }): Promise<RecordedAction> {
  const type = (a.type || 'action').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64).replace(/^[^a-z]+/, 'a_')
  const billable = a.billable ?? isBillableType(type)
  const r = await db.one<{ id: string }>(`insert into actions (org_id, agent_key, type, kind, billable, proof_ref, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (org_id, dedupe_key) do nothing returning id`, [a.orgId, a.agentKey.slice(0, 120), type, a.kind ?? 'action', billable, a.proofRef?.slice(0, 200) ?? null, a.dedupeKey.slice(0, 200)])
  if (r) return { id: r.id, billable, duplicate: false }
  const old = (await db.one<{ id: string; billable: boolean }>('select id, billable from actions where org_id = $1 and dedupe_key = $2', [a.orgId, a.dedupeKey.slice(0, 200)]))!
  return { id: old.id, billable: old.billable, duplicate: true }
}

/** The organization's plan key (Office plan key when set, else its Store tier). */
export async function planOf(db: Db, orgId: string): Promise<PlanKey> {
  const o = await db.one<{ plan_key: string | null; plan_tier: string | null }>('select plan_key, plan_tier from agencies where id = $1', [orgId])
  if (isOfficePlan(o?.plan_key)) return o!.plan_key as PlanKey
  if (isStorePlan(o?.plan_key)) return o!.plan_key as PlanKey
  return isStorePlan(o?.plan_tier) ? o!.plan_tier as PlanKey : 'starter'
}

export type Meter = { used: number; included: number; overageAllowed: number; cap: number; overage: number; atCap: boolean }
export type UsageState = { plan: PlanKey; month: string; actions: Meter; texts: Meter | null }

export async function usageState(db: Db, orgId: string, now = new Date()): Promise<UsageState> {
  const plan = await planOf(db, orgId)
  const counts = await db.query<{ kind: ActionKind; n: number }>(`select kind, count(*)::int as n from actions where org_id = $1 and billable and created_at >= $2 and created_at < $3 group by kind`,
    [orgId, monthFrom(now).toISOString(), monthTo(now).toISOString()])
  const used = (k: ActionKind) => counts.find(c => c.kind === k)?.n ?? 0
  const caps = await db.one<{ action_overage_cap_cents: number; text_overage_cap_cents: number }>('select action_overage_cap_cents, text_overage_cap_cents from org_usage_caps where org_id = $1', [orgId])
  const meter = (u: number, included: number, capCents: number, unit: number, block: number): Meter => {
    const overageAllowed = unitsForCap(capCents, unit, block)
    const cap = included + overageAllowed
    return { used: u, included, overageAllowed, cap, overage: Math.max(0, u - included), atCap: u >= cap }
  }
  if (isOfficePlan(plan)) {
    const p = officePlan(plan), o = CATALOG.office.overage
    return { plan, month: monthKey(now), actions: meter(used('action'), p.actions, caps?.action_overage_cap_cents ?? 0, o.unitActions, o.actionPriceCents), texts: meter(used('text'), p.texts, caps?.text_overage_cap_cents ?? 0, o.unitTexts, o.textPriceCents) }
  }
  const p = storePlan(plan as 'starter'), o = CATALOG.store.overage
  return { plan, month: monthKey(now), actions: meter(used('action'), p.actions, caps?.action_overage_cap_cents ?? 0, o.unitActions, o.priceCents), texts: null }
}

/** Set the customer's monthly overage cap (owner/admin; checked by the caller). */
export async function setOverageCap(db: Db, orgId: string, c: { actionCapCents?: number; textCapCents?: number; by: string }) {
  const clean = (v: number | undefined) => (v === undefined ? null : Math.max(0, Math.min(10_000_000, Math.round(v))))
  await db.query(`insert into org_usage_caps (org_id, action_overage_cap_cents, text_overage_cap_cents, updated_by) values ($1, coalesce($2, 0), coalesce($3, 0), $4)
    on conflict (org_id) do update set action_overage_cap_cents = coalesce($2, org_usage_caps.action_overage_cap_cents), text_overage_cap_cents = coalesce($3, org_usage_caps.text_overage_cap_cents),
      updated_by = $4, updated_at = now()`, [orgId, clean(c.actionCapCents), clean(c.textCapCents), c.by.slice(0, 160)])
}

export type CapDecision = { allowed: true } | { allowed: false; reason: string; kind: ActionKind; used: number; cap: number }

/**
 * May this step go ahead under the monthly cap? Billable, non-urgent steps pause at the cap; the owner is told once a
 * month per kind. Free steps, urgent steps and billing-off environments always pass.
 */
export async function capCheck(db: Db, orgId: string, type: string, now = new Date(), kind: ActionKind = 'action'): Promise<CapDecision> {
  if (billingMode() === 'off' || !isBillableType(type)) return { allowed: true }
  const s = await usageState(db, orgId, now)
  const m = kind === 'text' ? s.texts ?? s.actions : s.actions
  if (!m.atCap || isUrgentType(type)) return { allowed: true }
  const first = await db.one(`insert into usage_cap_events (org_id, month, kind) values ($1,$2,$3) on conflict do nothing returning org_id`, [orgId, s.month, kind])
  if (first) {
    const label = kind === 'text' ? 'texts' : 'actions'
    await notifyOwner({ orgId, agentKey: 'billing', agentName: 'Deploi billing', headline: `Your ${label} for this month are used up`,
      whatHappened: `Your agents have used ${m.used.toLocaleString('en-US')} of the ${m.cap.toLocaleString('en-US')} ${label} your plan and overage cap allow this month.`,
      whatIDid: ['Paused non-urgent work. Nothing is lost: it waits and goes out when you raise the cap or the month resets.', 'Replies to customers who are waiting still go out.'],
      proof: [{ label: `${label} used`, value: `${m.used} of ${m.cap}` }], detailsPath: '/store/billing', severity: 'action', dedupeKey: `cap:${s.month}:${kind}` }).catch(() => undefined)
  }
  return { allowed: false, reason: `the monthly ${kind === 'text' ? 'text' : 'action'} cap is reached (${m.used} of ${m.cap}); non-urgent work waits`, kind, used: m.used, cap: m.cap }
}

/** Convenience for callers outside a transaction. */
export const recordActionAdmin = (a: Parameters<typeof recordAction>[1]) => admin(db => recordAction(db, a))
