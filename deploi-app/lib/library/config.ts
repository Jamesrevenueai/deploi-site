/**
 * The agent library: twelve agents, three tiers, three permission levels. One JSON file
 * (agent-library.json) is the only source of truth; the website imports the same file, so the app
 * and the site can never disagree about an agent's name, description or tier. Tier membership is
 * data: moving an agent between tiers is an edit to the JSON, never a code change.
 */
import raw from './agent-library.json'

export type PermissionLevel = 'read' | 'draft' | 'act'
export type TierKey = 'starter' | 'growth' | 'pro'
export type AgentTool = 'shopify' | 'email'

export type ActionType = { key: string; label: string; /** true when the action changes something or sends something */ writes: boolean }
export type LibraryAgent = {
  key: string
  name: string
  status: 'existing' | 'new'
  /** engine template this agent is built on (the three agents that already run on the correction engine) */
  templateKey?: string
  character: { emoji: string; hue: number; shape: 'round' | 'square' }
  tagline: string
  description: string
  exampleTask: string
  tools: AgentTool[]
  actionTypes: ActionType[]
  scopes: string[]
  /** Shopify "protected customer data" scopes: need a separate App Store justification */
  protectedScopes: string[]
}
export type Tier = {
  key: TierKey
  name: string
  order: number
  tagline: string
  agents: string[]
  monthlyActions: number
  /** proposed, not approved: the site shows "coming soon" while pricingStatus is coming_soon */
  proposedPriceUsd: number
  proposedOverageUsd: number
  buildYourOwn: boolean
}
export type AgentLibrary = {
  version: number
  pricingStatus: 'coming_soon' | 'published'
  currency: string
  permissionLevels: { key: PermissionLevel; label: string; description: string }[]
  tiers: Tier[]
  agents: LibraryAgent[]
}

export const LIBRARY = raw as AgentLibrary
export const TIER_KEYS: TierKey[] = ['starter', 'growth', 'pro']
export const PERMISSION_LEVELS: PermissionLevel[] = ['read', 'draft', 'act']
/** the most restrictive level; every agent and every custom agent starts here or lower */
export const DEFAULT_PERMISSION: PermissionLevel = 'draft'
export const permissionRank = (p: PermissionLevel) => PERMISSION_LEVELS.indexOf(p)

export const agentByKey = (key: string): LibraryAgent | null => LIBRARY.agents.find(a => a.key === key) ?? null
export const tierByKey = (key: string): Tier | null => LIBRARY.tiers.find(t => t.key === key) ?? null
export const isTierKey = (v: unknown): v is TierKey => typeof v === 'string' && TIER_KEYS.includes(v as TierKey)
export const isPermissionLevel = (v: unknown): v is PermissionLevel => typeof v === 'string' && PERMISSION_LEVELS.includes(v as PermissionLevel)

/** Is this agent included in the tier? Config-driven: reads the tier's agent list. */
export function tierIncludes(tier: TierKey, agentKey: string): boolean {
  return tierByKey(tier)?.agents.includes(agentKey) ?? false
}
/** The lowest tier that includes the agent (what the Upgrade button offers). */
export function lowestTierFor(agentKey: string): Tier | null {
  return [...LIBRARY.tiers].sort((a, b) => a.order - b.order).find(t => t.agents.includes(agentKey)) ?? null
}
export function tierRank(tier: TierKey): number { return tierByKey(tier)?.order ?? 0 }
export const isUpgrade = (from: TierKey, to: TierKey) => tierRank(to) > tierRank(from)
export const actionTypeOf = (agentKey: string, actionKey: string): ActionType | null => agentByKey(agentKey)?.actionTypes.find(a => a.key === actionKey) ?? null

/** Checks the JSON is coherent; run in tests and at module load so a bad edit fails fast. */
export function validateLibrary(lib: AgentLibrary = LIBRARY): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const a of lib.agents) {
    if (keys.has(a.key)) problems.push(`duplicate agent key ${a.key}`)
    keys.add(a.key)
    if (!a.actionTypes.length) problems.push(`${a.key} has no action types`)
    for (const s of a.protectedScopes) if (!a.scopes.includes(s)) problems.push(`${a.key}: protected scope ${s} is not in its scopes`)
  }
  const seenTiers = new Set<string>()
  for (const t of lib.tiers) {
    if (seenTiers.has(t.key)) problems.push(`duplicate tier ${t.key}`)
    seenTiers.add(t.key)
    for (const k of t.agents) if (!keys.has(k)) problems.push(`tier ${t.key} names unknown agent ${k}`)
    if (t.monthlyActions <= 0) problems.push(`tier ${t.key} has no action allowance`)
  }
  const ordered = [...lib.tiers].sort((a, b) => a.order - b.order)
  for (let i = 1; i < ordered.length; i++) {
    const missing = ordered[i - 1].agents.filter(k => !ordered[i].agents.includes(k))
    if (missing.length) problems.push(`tier ${ordered[i].key} lacks ${missing.join(', ')} from ${ordered[i - 1].key}`)
  }
  for (const k of keys) if (!lib.tiers.some(t => t.agents.includes(k))) problems.push(`agent ${k} is in no tier`)
  return problems
}

const startupProblems = validateLibrary()
if (startupProblems.length) throw new Error(`agent-library.json is invalid: ${startupProblems.join('; ')}`)
