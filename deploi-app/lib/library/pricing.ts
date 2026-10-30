/**
 * Cost of one agent action and the margin each tier leaves. Every number here is an estimate the
 * founder approves: the model prices are Anthropic list prices at the time of writing, the token
 * counts are what one action of each kind is expected to use (a store read plus a short draft).
 * The app records real token use per action in library_usage so the estimate can be replaced by
 * measurement once a model is wired in.
 */
import { LIBRARY, type Tier, type TierKey } from './config'

/** USD per million tokens (Anthropic list prices, 2026-10). Change here, never in the UI. */
export const MODEL_PRICES = {
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
} as const
export type ModelId = keyof typeof MODEL_PRICES
/** The model the agents are costed on. Drafting quality matters more than the cents, so Sonnet. */
export const DEFAULT_MODEL: ModelId = 'claude-sonnet-5-5'

/** Expected tokens for one action: the store data it reads (input) and what it writes (output). */
export const ACTION_TOKENS: Record<string, { input: number; output: number }> = {
  flag_late_order: { input: 3000, output: 150 },
  draft_customer_update: { input: 3500, output: 350 },
  draft_return_reply: { input: 4000, output: 400 },
  approve_return: { input: 4000, output: 200 },
  draft_title: { input: 2500, output: 120 },
  draft_description: { input: 3000, output: 400 },
  flag_oversold: { input: 2000, output: 100 },
  draft_inventory_policy_fix: { input: 2500, output: 150 },
  draft_restock_request: { input: 3000, output: 350 },
  draft_supplier_followup: { input: 3500, output: 250 },
  draft_customer_reply: { input: 4500, output: 400 },
  send_customer_reply: { input: 4500, output: 400 },
  draft_campaign_email: { input: 6000, output: 900 },
  propose_discount: { input: 4000, output: 250 },
  create_discount: { input: 4000, output: 200 },
  end_discount: { input: 2000, output: 100 },
  weekly_summary: { input: 12000, output: 900 },
  reconcile_payout: { input: 8000, output: 300 },
  flag_fee_anomaly: { input: 6000, output: 200 },
  health_report: { input: 10000, output: 700 },
  check_ai_visibility: { input: 3000, output: 200 },
  recommend_visibility_fix: { input: 3000, output: 300 },
  chat_turn: { input: 5000, output: 400 },
  custom_agent_run: { input: 8000, output: 600 },
}
/** When an action key is unknown (a custom agent's action), this is the estimate. */
const FALLBACK_TOKENS = ACTION_TOKENS.custom_agent_run

/** Multiplies the model cost to cover retries, verification reads and the engine's own reads. */
export const OVERHEAD_FACTOR = 1.5

export function tokensFor(actionKey: string) { return ACTION_TOKENS[actionKey] ?? FALLBACK_TOKENS }

/** Estimated model cost of one action in USD. */
export function costPerAction(actionKey: string, model: ModelId = DEFAULT_MODEL): number {
  const t = tokensFor(actionKey)
  const p = MODEL_PRICES[model]
  return ((t.input * p.input + t.output * p.output) / 1e6) * OVERHEAD_FACTOR
}

/** Average cost across every action type in the library, weighted equally. */
export function averageCostPerAction(model: ModelId = DEFAULT_MODEL): number {
  const keys = LIBRARY.agents.flatMap(a => a.actionTypes.map(t => t.key))
  return keys.reduce((s, k) => s + costPerAction(k, model), 0) / keys.length
}

export type TierEconomics = {
  tier: TierKey
  monthlyActions: number
  proposedPriceUsd: number
  proposedOverageUsd: number
  /** model cost if the merchant uses the whole allowance */
  costAtFullAllowanceUsd: number
  grossMarginAtFullAllowance: number
  overageMargin: number
  costPerActionUsd: number
}

export function tierEconomics(t: Tier, model: ModelId = DEFAULT_MODEL): TierEconomics {
  const cpa = averageCostPerAction(model)
  const cost = cpa * t.monthlyActions
  return {
    tier: t.key, monthlyActions: t.monthlyActions, proposedPriceUsd: t.proposedPriceUsd, proposedOverageUsd: t.proposedOverageUsd,
    costAtFullAllowanceUsd: round2(cost),
    grossMarginAtFullAllowance: round2((t.proposedPriceUsd - cost) / t.proposedPriceUsd),
    overageMargin: round2((t.proposedOverageUsd - cpa) / t.proposedOverageUsd),
    costPerActionUsd: round4(cpa),
  }
}
export const allTierEconomics = (model: ModelId = DEFAULT_MODEL) => LIBRARY.tiers.map(t => tierEconomics(t, model))

/** What the merchant would owe this month: base fee plus overage past the allowance. Prices are proposals until approved. */
export function monthlyBill(t: Tier, actionsUsed: number) {
  const over = Math.max(0, actionsUsed - t.monthlyActions)
  return { base: t.proposedPriceUsd, overageActions: over, overage: round2(over * t.proposedOverageUsd), total: round2(t.proposedPriceUsd + over * t.proposedOverageUsd) }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000
