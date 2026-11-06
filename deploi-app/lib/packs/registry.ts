/**
 * Agent packs and the two doors. SHARED REGISTRY — each workstream adds its pack's agents here.
 * Standalone web app: every pack. Shopify embedded app: the commerce pack plus Office features that work for a
 * store, and only agents marked shopifyReady (Shopify review must see only working features).
 */
export type PackKey = 'commerce' | 'home_services' | 'leasing' | 'real_estate' | 'property_management' | 'office'
export type BusinessType = 'store' | 'home_services' | 'leasing_agent' | 'real_estate_agent' | 'property_manager' | 'office'
export type PackAgent = {
  key: string
  name: string
  pack: PackKey
  /** one line, plain words */
  job: string
  /** event types this agent reacts to (see lib/events) */
  triggers: string[]
  /** action types it can take (see lib/autonomy) */
  actions: string[]
  /** fully working end to end on the platform it needs */
  status: 'working' | 'synthetic_only' | 'planned'
  /** shown in the Shopify embedded app */
  shopifyReady: boolean
}
export const PACKS: Record<PackKey, { name: string; businessTypes: BusinessType[] }> = {
  commerce: { name: 'Commerce', businessTypes: ['store'] },
  home_services: { name: 'Home services', businessTypes: ['home_services'] },
  leasing: { name: 'Leasing and apartment locating', businessTypes: ['leasing_agent', 'property_manager'] },
  real_estate: { name: 'Real estate agents', businessTypes: ['real_estate_agent'] },
  property_management: { name: 'Property management', businessTypes: ['property_manager'] },
  office: { name: 'General office', businessTypes: ['store', 'home_services', 'leasing_agent', 'real_estate_agent', 'property_manager', 'office'] },
}
export const PACK_AGENTS: PackAgent[] = []
export function registerPackAgents(list: PackAgent[]) { for (const a of list) if (!PACK_AGENTS.some(x => x.key === a.key)) PACK_AGENTS.push(a) }
export const agentsFor = (door: 'standalone' | 'shopify') => PACK_AGENTS.filter(a => door === 'standalone' || (a.shopifyReady && (a.pack === 'commerce' || a.pack === 'office')))
