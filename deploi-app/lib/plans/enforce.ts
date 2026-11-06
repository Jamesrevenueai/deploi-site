/**
 * Bringing an organization within its plan after the plan drops (a Stripe downgrade, a cancelled
 * subscription, or one unpaid or past due beyond its grace period). Deterministic and idempotent; nothing is
 * deleted and every page and record stays readable:
 *   1. library agents the applicable tier does not include are switched off (their engine agents paused,
 *      open drafts expired), as a merchant's own downgrade does (switchOffExcluded)
 *   2. active engine agents beyond maxAgents are paused, most recently created first (ties by id); the
 *      oldest maxAgents keep running
 *   3. active Office agents beyond officeSeats are paused the same way
 * Each pause is audited with the reason, and one plan.enforced entry records what changed. Upgrades and
 * recoveries never resume or switch anything back on: the merchant does that, within the new limits.
 * The applicable tier is effectiveTier(): a lapsed subscription falls back to the lowest tier.
 * Only while BILLING_MODE is on; with billing off the merchant's own tier change (setTier) does step 1.
 *
 * Called by the Stripe webhook after every processed subscription or invoice event (lib/billing/webhooks.ts)
 * and hourly for subscriptions that may have lapsed by time alone (past due beyond grace).
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { billingMode } from '../billing/config'
import { pauseAgentInTx } from '../agents/lifecycle'
import { pauseOfficeAgentInTx } from '../office/agents'
import { switchOffExcluded } from '../library/switches'
import { tierByKey, type TierKey } from '../library/config'
import { effectiveTier, planLimits } from './entitlements'

export type EnforceResult = { tier: TierKey; lapsed: boolean; librarySwitchedOff: string[]; agentsPaused: string[]; officeAgentsPaused: string[]; changed: boolean }

export async function enforcePlanLimits(db: Db, orgId: string, opts: { actor: string; cause: string; now?: Date }): Promise<EnforceResult | null> {
  if (billingMode() === 'off') return null
  // one enforcement at a time per organization
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 4212))`, [`plan-enforce:${orgId}`])
  const { tier, lapsed, entitlements: e } = await effectiveTier(db, orgId, opts.now)
  const name = tierByKey(tier)?.name ?? tier
  // a lapsed subscription keeps its paid plan on record; the lowest tier's limits apply until it is paid again
  const limits = lapsed ? await planLimits(db, tier) : e
  const planWords = lapsed ? `the subscription lapsed, so the ${name} limits apply` : `the ${e.label} applies`
  const librarySwitchedOff = await switchOffExcluded(db, orgId, tier, opts.actor, `${planWords}: the plan no longer includes this agent`)

  const active = await db.query<{ id: string }>(`select id from agents where org_id = $1 and status = 'active' order by created_at desc, id desc for update`, [orgId])
  const agentsPaused: string[] = []
  const overAgents = active.length - limits.maxAgents
  for (const a of active.slice(0, Math.max(0, overAgents))) {
    const r = await pauseAgentInTx(db, orgId, a.id, opts.actor, `${planWords}: it allows ${limits.maxAgents} active agents and this is one of the most recently created`)
    if (r) agentsPaused.push(a.id)
  }

  const office = await db.query<{ id: string }>(`select id from office_agents where org_id = $1 and status = 'active' order by created_at desc, id desc for update`, [orgId])
  const officeAgentsPaused: string[] = []
  const limit = limits.officeSeats
  for (const a of office.slice(0, Math.max(0, office.length - limit))) {
    const r = await pauseOfficeAgentInTx(db, orgId, a.id, opts.actor, `${planWords}: it allows ${limit} Office seats and this is one of the most recently created Office agents`)
    if (r) officeAgentsPaused.push(a.id)
  }
  const changed = librarySwitchedOff.length + agentsPaused.length + officeAgentsPaused.length > 0
  if (changed) await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'plan.enforced', actor: opts.actor,
    detail: { cause: opts.cause, tier, lapsed, max_agents: limits.maxAgents, office_seats: limit, library_switched_off: librarySwitchedOff, agents_paused: agentsPaused, office_agents_paused: officeAgentsPaused } })
  return { tier, lapsed, librarySwitchedOff, agentsPaused, officeAgentsPaused, changed }
}

/** Hourly: Stripe subscriptions that are not in good standing may have lapsed by time alone (grace ended). */
export async function enforceLapsedPlans(opts: { now?: Date; limit?: number } = {}) {
  if (billingMode() === 'off') return []
  const orgs = await admin(db => db.query<{ org_id: string }>(
    `select org_id from billing_subscriptions where provider = 'stripe' and status in ('past_due','unpaid','canceled','paused') order by org_id limit $1`, [opts.limit ?? 500]))
  const out: EnforceResult[] = []
  for (const o of orgs) {
    const r = await admin(db => enforcePlanLimits(db, o.org_id, { actor: 'system:plan', cause: 'subscription not in good standing', now: opts.now }))
    if (r?.changed) out.push(r)
  }
  return out
}
