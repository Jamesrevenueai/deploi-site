/**
 * Plan entitlements and usage safeguards (from PR #4, adapted to the Competitor & Trend Watcher kept from
 * PR #3), extended with paid plans.
 *
 * While BILLING_MODE=off (the default: the free beta) nothing changes: no price is charged and the limits
 * below come from the environment, exactly as before.
 *
 *   PLAN_KEY                       beta_free (default)
 *   PLAN_MAX_AGENTS                agents per organization that are not deleted (default 10)
 *   PLAN_MAX_COMPETITOR_STORES     competitor stores watched across the organization (default 25)
 *
 * With BILLING_MODE=test|live the limits derive from the organization's plan (PLAN_LIMITS, keyed by the
 * library tier starter|growth|pro): engine agents, watched competitor stores, monthly agent actions
 * (the tier's allowance in agent-library.json), monthly emails, and Office seats and connections. A
 * subscription that is past its grace period, cancelled or missing makes the organization read-only
 * (lib/billing/state.ts): agents stop writes and sends, data stays visible.
 *
 * The agent library's own tiers (lib/library/agent-library.json) decide which library agents can be switched
 * on; these limits sit underneath them and apply to every engine agent.
 */
import type { Db } from '../db'
import { EngineError } from '../engine/errors'
import type { AgentPolicy } from '../agents/policy'
import { LIBRARY, tierByKey, isTierKey, type TierKey } from '../library/config'
import { billingMode } from '../billing/config'
import { billingState, type BillingState } from '../billing/state'

const num = (k: string, d: number) => { const v = Number((process.env[k] ?? '').trim()); return Number.isInteger(v) && v > 0 ? v : d }

export type Entitlements = { plan: string; label: string; priced: false; maxAgents: number; maxCompetitorStores: number }

/** The free-beta entitlements (BILLING_MODE=off). */
export function entitlements(): Entitlements {
  return { plan: (process.env.PLAN_KEY ?? '').trim() || 'beta_free', label: 'Free beta', priced: false, maxAgents: num('PLAN_MAX_AGENTS', 10), maxCompetitorStores: num('PLAN_MAX_COMPETITOR_STORES', 25) }
}

export type PlanLimits = {
  maxAgents: number
  maxCompetitorStores: number
  monthlyActions: number
  monthlyEmails: number
  officeSeats: number
  officeConnections: number
}

/**
 * Per-plan limits (proposals for the founder to approve, like the prices in docs/PRICING-PROPOSAL.md).
 * monthlyActions is read from the tier in agent-library.json so the app and the site never disagree.
 */
export const PLAN_LIMITS: Record<TierKey, PlanLimits> = {
  starter: { maxAgents: 5, maxCompetitorStores: 5, monthlyActions: tierByKey('starter')?.monthlyActions ?? 150, monthlyEmails: 200, officeSeats: 2, officeConnections: 2 },
  growth: { maxAgents: 12, maxCompetitorStores: 15, monthlyActions: tierByKey('growth')?.monthlyActions ?? 500, monthlyEmails: 1000, officeSeats: 5, officeConnections: 5 },
  pro: { maxAgents: 30, maxCompetitorStores: 50, monthlyActions: tierByKey('pro')?.monthlyActions ?? 1500, monthlyEmails: 5000, officeSeats: 15, officeConnections: 15 },
}

export type OrgEntitlements = PlanLimits & {
  plan: string
  tier: TierKey
  label: string
  priced: boolean
  billing: BillingState
  /** agents may write to stores and send email */
  writesAllowed: boolean
}

/** The organization's entitlements now: the free beta while billing is off, otherwise its paid plan. */
export async function orgEntitlements(db: Db, orgId: string, now = new Date()): Promise<OrgEntitlements> {
  const org = await db.one<{ plan_tier: string | null }>('select plan_tier from agencies where id = $1', [orgId])
  const orgTier: TierKey = isTierKey(org?.plan_tier) ? org!.plan_tier as TierKey : LIBRARY.tiers[0].key
  const billing = await billingState(db, orgId, now)
  if (billing.mode === 'off') {
    const e = entitlements()
    return { ...PLAN_LIMITS[orgTier], maxAgents: e.maxAgents, maxCompetitorStores: e.maxCompetitorStores, plan: e.plan, tier: orgTier, label: e.label, priced: false, billing, writesAllowed: true }
  }
  // a Stripe subscription's plan wins; Shopify-billed organizations keep the tier recorded on the organization
  const tier: TierKey = billing.provider === 'stripe' && billing.plan ? billing.plan : orgTier
  const t = tierByKey(tier)
  return { ...PLAN_LIMITS[tier], plan: tier, tier, label: `${t?.name ?? tier} plan`, priced: true, billing, writesAllowed: !billing.readOnly }
}

/** Throws when creating (agentId null) or widening this agent would exceed the plan. */
export async function assertWithinPlan(db: Db, orgId: string, policy: AgentPolicy, agentId: string | null) {
  const e = await orgEntitlements(db, orgId)
  if (!agentId) {
    const n = await db.one<{ n: string }>(`select count(*)::text as n from agents where org_id = $1 and status <> 'deleted'`, [orgId])
    if (Number(n?.n ?? 0) >= e.maxAgents) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxAgents} agents; delete one first`)
  }
  if (policy.competitors) {
    const others = await db.one<{ n: string }>(
      `select coalesce(sum(jsonb_array_length(p.policy->'competitors'->'stores')), 0)::text as n from agents a join agent_policies p on p.id = a.active_policy_id
       where a.org_id = $1 and a.status in ('active','paused','draft') and ($2::uuid is null or a.id <> $2) and p.policy ? 'competitors'`, [orgId, agentId])
    const total = Number(others?.n ?? 0) + policy.competitors.stores.length
    if (total > e.maxCompetitorStores) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxCompetitorStores} watched competitor stores in total (this would make ${total})`)
  }
}

export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))

/**
 * Why agents of this organization may not send email now (read-only plan, or the month's email
 * allowance used), or null. No query while billing is off.
 */
export async function billingSendBlock(db: Db, orgId: string, now = new Date()): Promise<string | null> {
  if (billingMode() === 'off') return null
  const e = await orgEntitlements(db, orgId, now)
  if (!e.writesAllowed) return `read-only: ${e.billing.reason}`
  const sent = await db.one<{ n: string }>(`select count(*)::text as n from email_messages where org_id = $1 and status in ('sending','accepted','delivery_unknown') and created_at >= $2`, [orgId, monthStart(now).toISOString()])
  if (Number(sent?.n ?? 0) >= e.monthlyEmails) return `the ${e.label} allows ${e.monthlyEmails} emails a month; this month's allowance is used`
  return null
}

/** Throws when an Office seat or connection count would exceed the plan (for the Office workstream's entry points). */
export async function assertOfficeWithinPlan(db: Db, orgId: string, what: { seats?: number; connections?: number }) {
  const e = await orgEntitlements(db, orgId)
  if (what.seats !== undefined && what.seats > e.officeSeats) throw new EngineError('invalid_input', `the ${e.label} allows ${e.officeSeats} Office seats`)
  if (what.connections !== undefined && what.connections > e.officeConnections) throw new EngineError('invalid_input', `the ${e.label} allows ${e.officeConnections} Office connections`)
}
