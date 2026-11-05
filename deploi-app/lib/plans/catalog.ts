/**
 * Configurable plans (table `plans`): prices, Stripe price ids and limits change without a code change.
 *
 *  - Limits: lib/plans/entitlements.ts reads them from here (cached for PLANS_CACHE_MS, default 60 s, in
 *    each server instance), falling back to the PLAN_LIMITS constants when the table is empty or a key is
 *    missing. The plan that applies is the organization's plan_key when set and active, otherwise the row
 *    whose key is the organization's library tier (starter, growth, pro).
 *  - Status: every seeded plan is a `hypothesis` (a proposal). A hypothesis can be bought through Stripe
 *    test mode only; live checkout refuses it until an owner approves it (status `approved`). Only a staff
 *    member listed in PRICING_APPROVER_EMAILS can approve. Changing the price, the Stripe price or the limits
 *    of an approved plan makes it a hypothesis again (it needs approval again).
 *  - Existing subscriptions: editing a plan never touches Stripe or a subscription. A customer keeps
 *    paying the Stripe price they subscribed to until they change plan themselves; the new price applies
 *    to new checkouts only.
 *  - Every change bumps `version`, is recorded in plan_changes (who, what, before and after) and in the
 *    engine audit trail (global chain).
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { isTierKey, type TierKey } from '../library/config'

export type PlanSuite = 'office' | 'commerce' | 'both'
export type PlanStatus = 'hypothesis' | 'approved' | 'retired'
export type PlanLimitsJson = Partial<Record<'maxAgents' | 'monthlyActions' | 'monthlyEmails' | 'officeSeats' | 'officeConnections' | 'maxCompetitorStores' | 'aiBudgetUsd' | 'aiAgentBudgetUsd', number>>
export type PlanRow = {
  key: string; suite: PlanSuite; display_name: string; monthly_price_cents: number; currency: string; stripe_price_id: string | null; tier_key: TierKey
  limits: PlanLimitsJson; trial_days: number; active: boolean; status: PlanStatus; version: number; approved_by: string | null; approved_at: string | null; updated_by: string; updated_at: string
}

export const LIMIT_KEYS = ['maxAgents', 'monthlyActions', 'monthlyEmails', 'officeSeats', 'officeConnections', 'maxCompetitorStores', 'aiBudgetUsd', 'aiAgentBudgetUsd'] as const

const cacheMs = () => { const v = Number((process.env.PLANS_CACHE_MS ?? '').trim()); return Number.isFinite(v) && v >= 0 && (process.env.PLANS_CACHE_MS ?? '').trim() !== '' ? v : 60_000 }
let cache: { at: number; rows: PlanRow[] } | null = null

/** Forget the cached plans (after an edit; tests). */
export function invalidatePlanCache() { cache = null }

const SELECT = `select key, suite, display_name, monthly_price_cents, currency, stripe_price_id, tier_key, limits, trial_days, active, status, version, approved_by, approved_at::text, updated_by, updated_at::text from plans`

/** Every plan (cached). An unreachable or missing table reads as no plans: the constants apply. */
export async function loadPlans(db?: Db): Promise<PlanRow[]> {
  if (cache && Date.now() - cache.at < cacheMs()) return cache.rows
  const read = (d: Db) => d.query<PlanRow>(`${SELECT} order by monthly_price_cents, key`)
  let rows: PlanRow[]
  try { rows = db ? await read(db) : await admin(read) } catch { return [] }
  cache = { at: Date.now(), rows }
  return rows
}

export async function planByKey(key: string | null | undefined, db?: Db): Promise<PlanRow | null> {
  if (!key) return null
  return (await loadPlans(db)).find(p => p.key === key) ?? null
}

/** The plan row whose limits apply: the organization's chosen active plan, else the row named like its tier. */
export async function applicablePlan(tier: TierKey, planKey: string | null | undefined, db?: Db): Promise<PlanRow | null> {
  const rows = await loadPlans(db)
  const chosen = planKey ? rows.find(p => p.key === planKey && p.active && p.status !== 'retired') : null
  return chosen ?? rows.find(p => p.key === tier) ?? null
}

/** May this plan be sold through Stripe in this billing mode? A hypothesis or retired plan never in live mode. */
export function checkoutRefusal(plan: Pick<PlanRow, 'key' | 'status' | 'active'>, mode: 'off' | 'test' | 'live'): string | null {
  if (!plan.active || plan.status === 'retired') return `the ${plan.key} plan is not on sale`
  if (mode === 'live' && plan.status !== 'approved') return `the ${plan.key} plan is a pricing hypothesis: the owner must approve it before it can be sold (test mode only until then)`
  return null
}

function approvers(): string[] {
  return (process.env.PRICING_APPROVER_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export class PlanEditError extends Error { constructor(public code: 'invalid_input' | 'not_found' | 'forbidden', message: string) { super(message); this.name = 'PlanEditError' } }

export type PlanPatch = Partial<{ suite: PlanSuite; displayName: string; monthlyPriceCents: number; currency: string; stripePriceId: string | null; tierKey: TierKey; limits: PlanLimitsJson; trialDays: number; active: boolean; status: PlanStatus }>

function validPatch(p: Record<string, unknown>): PlanPatch {
  const out: PlanPatch = {}
  const bad = (m: string) => { throw new PlanEditError('invalid_input', m) }
  if (p.suite !== undefined) out.suite = ['office', 'commerce', 'both'].includes(p.suite as string) ? p.suite as PlanSuite : bad('suite must be office, commerce or both')
  if (p.displayName !== undefined) out.displayName = typeof p.displayName === 'string' && p.displayName.trim().length >= 1 && p.displayName.length <= 80 ? p.displayName.trim() : bad('displayName must be 1 to 80 characters')
  if (p.monthlyPriceCents !== undefined) out.monthlyPriceCents = Number.isInteger(p.monthlyPriceCents) && (p.monthlyPriceCents as number) >= 0 && (p.monthlyPriceCents as number) <= 10_000_000 ? p.monthlyPriceCents as number : bad('monthlyPriceCents must be a whole number of cents')
  if (p.currency !== undefined) out.currency = typeof p.currency === 'string' && /^[a-z]{3}$/.test(p.currency) ? p.currency : bad('currency must be a 3-letter lowercase code')
  if (p.stripePriceId !== undefined) out.stripePriceId = p.stripePriceId === null || (typeof p.stripePriceId === 'string' && /^price_[A-Za-z0-9]+$/.test(p.stripePriceId)) ? p.stripePriceId as string | null : bad('stripePriceId must be price_... or null')
  if (p.tierKey !== undefined) out.tierKey = isTierKey(p.tierKey) ? p.tierKey : bad('tierKey must be starter, growth or pro')
  if (p.trialDays !== undefined) out.trialDays = Number.isInteger(p.trialDays) && (p.trialDays as number) >= 0 && (p.trialDays as number) <= 90 ? p.trialDays as number : bad('trialDays must be 0 to 90')
  if (p.active !== undefined) out.active = typeof p.active === 'boolean' ? p.active : bad('active must be true or false')
  if (p.status !== undefined) out.status = ['hypothesis', 'approved', 'retired'].includes(p.status as string) ? p.status as PlanStatus : bad('status must be hypothesis, approved or retired')
  if (p.limits !== undefined) {
    if (!p.limits || typeof p.limits !== 'object' || Array.isArray(p.limits)) bad('limits must be an object')
    const l: PlanLimitsJson = {}
    for (const [k, v] of Object.entries(p.limits as Record<string, unknown>)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(k)) bad(`unknown limit ${k}`)
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) bad(`limit ${k} must be a number from 0`)
      l[k as keyof PlanLimitsJson] = v as number
    }
    out.limits = l
  }
  return out
}

/**
 * Staff edit of one plan (or a new plan when `create` is set and the key is free). Approving needs an
 * approver e-mail; a change to price, Stripe price or limits of an approved plan without approving in the
 * same edit returns it to `hypothesis`. Never changes a subscription.
 */
export async function editPlan(db: Db, input: { key: string; patch: Record<string, unknown>; staffEmail: string; create?: boolean }): Promise<PlanRow> {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(input.key)) throw new PlanEditError('invalid_input', 'invalid plan key')
  const patch = validPatch(input.patch)
  const actor = `staff:${input.staffEmail}`
  let before = await db.one<PlanRow>(`${SELECT} where key = $1 for update`, [input.key])
  if (!before) {
    if (!input.create) throw new PlanEditError('not_found', 'no such plan')
    if (!patch.suite || !patch.displayName || patch.monthlyPriceCents === undefined || !patch.tierKey) throw new PlanEditError('invalid_input', 'a new plan needs suite, displayName, monthlyPriceCents and tierKey')
    await db.query(`insert into plans (key, suite, display_name, monthly_price_cents, tier_key, status, updated_by) values ($1,$2,$3,$4,$5,'hypothesis',$6)`, [input.key, patch.suite, patch.displayName, patch.monthlyPriceCents, patch.tierKey, actor])
    before = (await db.one<PlanRow>(`${SELECT} where key = $1 for update`, [input.key]))!
  }
  const approving = patch.status === 'approved' && before.status !== 'approved'
  if (patch.status === 'approved' && !approvers().includes(input.staffEmail.toLowerCase())) throw new PlanEditError('forbidden', 'only the owner (PRICING_APPROVER_EMAILS) can approve a price')
  const priceChanged = (patch.monthlyPriceCents !== undefined && patch.monthlyPriceCents !== before.monthly_price_cents)
    || (patch.stripePriceId !== undefined && patch.stripePriceId !== before.stripe_price_id) || (patch.currency !== undefined && patch.currency !== before.currency)
    || (patch.limits !== undefined && JSON.stringify(patch.limits) !== JSON.stringify(before.limits))
  let status: PlanStatus = patch.status ?? before.status
  if (status === 'approved' && priceChanged && patch.status !== 'approved') status = 'hypothesis'
  const approvedBy = status === 'approved' ? (approving || priceChanged ? actor : before.approved_by) : null
  await db.query(
    `update plans set suite = $2, display_name = $3, monthly_price_cents = $4, currency = $5, stripe_price_id = $6, tier_key = $7, limits = $8, trial_days = $9, active = $10,
       status = $11, approved_by = $12, approved_at = case when $11 = 'approved' then (case when $13 then now() else coalesce(approved_at, now()) end) else null end,
       version = version + 1, updated_by = $14, updated_at = now() where key = $1`,
    [input.key, patch.suite ?? before.suite, patch.displayName ?? before.display_name, patch.monthlyPriceCents ?? before.monthly_price_cents, patch.currency ?? before.currency,
      patch.stripePriceId !== undefined ? patch.stripePriceId : before.stripe_price_id, patch.tierKey ?? before.tier_key, JSON.stringify(patch.limits ?? before.limits),
      patch.trialDays ?? before.trial_days, patch.active ?? before.active, status, approvedBy, approving || priceChanged, actor])
  const after = (await db.one<PlanRow>(`${SELECT} where key = $1`, [input.key]))!
  const change = { before: { ...before, updated_at: undefined }, after: { ...after, updated_at: undefined }, patch: input.patch }
  await db.query(`insert into plan_changes (plan_key, version, actor, change) values ($1,$2,$3,$4)`, [input.key, after.version, actor, JSON.stringify(change)])
  await audit(db, { orgId: null, entityType: 'subscription', entityId: `plan:${input.key}`, event: approving ? 'plan.approved' : 'plan.updated', actor,
    detail: { plan: input.key, version: after.version, status: after.status, price_cents: after.monthly_price_cents, changed: Object.keys(input.patch) } })
  invalidatePlanCache()
  return after
}
