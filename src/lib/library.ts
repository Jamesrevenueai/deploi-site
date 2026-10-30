/**
 * The agent library as the website shows it. This is the SAME file the app reads
 * (deploi-app/lib/library/agent-library.json): names, descriptions, example tasks, characters and
 * tier membership can never differ between the site and the app.
 */
import raw from '../../deploi-app/lib/library/agent-library.json'

export type TierKey = 'starter' | 'growth' | 'pro'
export type LibraryAgent = {
  key: string; name: string; status: 'existing' | 'new'; character: { emoji: string; hue: number; shape: 'round' | 'square' }
  tagline: string; description: string; exampleTask: string; tools: ('shopify' | 'email')[]
  actionTypes: { key: string; label: string; writes: boolean }[]; scopes: string[]; protectedScopes: string[]
}
export type Tier = { key: TierKey; name: string; order: number; tagline: string; agents: string[]; monthlyActions: number; proposedPriceUsd: number; proposedOverageUsd: number; buildYourOwn: boolean }
export type Library = { version: number; pricingStatus: 'coming_soon' | 'published'; currency: string; permissionLevels: { key: string; label: string; description: string }[]; tiers: Tier[]; agents: LibraryAgent[] }

export const LIBRARY = raw as Library
export const TIERS: Tier[] = [...LIBRARY.tiers].sort((a, b) => a.order - b.order)
export const AGENTS: LibraryAgent[] = LIBRARY.agents
export const PRICING_COMING_SOON = LIBRARY.pricingStatus !== 'published'

/** The lowest tier that includes the agent: what the site says "included from". */
export function lowestTierFor(agentKey: string): Tier | null {
  return TIERS.find(t => t.agents.includes(agentKey)) ?? null
}
export const tierIncludes = (tier: TierKey, agentKey: string) => TIERS.find(t => t.key === tier)?.agents.includes(agentKey) ?? false
