/**
 * The commerce launch pack: twelve Shopify agents that see the work, do it, verify it with a fresh read, log proof
 * and tell the owner after. Importing this module registers, once:
 *  - every agent's event handlers with the event router (lib/events): Shopify topics, mail, crew replies and the
 *    15-minute 'sweep';
 *  - the pack's agents in the pack registry (lib/packs/registry.ts) with their honest status;
 *  - the undo kinds for every reversible action (lib/undo).
 * Rules and templates only: no model is called.
 */
import { onEvent, type AgentEvent } from '../../events'
import { registerPackAgents } from '../../packs/registry'
import { registerUndo } from '../../undo'
import { COMMERCE_AGENTS } from './agents'
import { commerceStoreFor, runCommerceAgent, type CommerceRunResult } from './run'
import { withInboundText } from '../../email/message-text'

export { COMMERCE_AGENTS, commerceAgent } from './agents'
export { runCommerceAgent, decideCommerceWork, undoCommerceWork, setCommerceStoreOverride } from './run'
export { COMMERCE_PACK_SCOPES, PROTECTED_CUSTOMER_DATA } from './scopes'

/** Shopify webhook topics the pack listens to (W1's router turns each delivery into an AgentEvent of this type). */
export const COMMERCE_TOPICS = [
  'orders/create', 'orders/updated', 'orders/fulfilled', 'fulfillments/create', 'fulfillments/update', 'inventory_levels/update', 'products/create', 'products/update',
  'collections/update', 'customers/create', 'customers/update', 'refunds/create', 'returns/request', 'returns/update', 'discounts/create', 'discounts/update', 'payouts/update',
] as const

let registered = false
export function registerCommercePack() {
  if (registered) return
  registered = true
  for (const a of COMMERCE_AGENTS) for (const t of a.triggers) onEvent(t, a.key, async (db, e) => { const x = await withInboundText(db, e); if (x) await runCommerceAgent(a.key, x) })
  registerPackAgents(COMMERCE_AGENTS.map(a => ({
    key: a.key, name: a.name, pack: 'commerce' as const, job: a.job, triggers: a.triggers, actions: a.actions,
    // works end to end on the synthetic store; the live Admin GraphQL path is built and fake-tested but not verified
    // on a real store, and customer/supplier email has no live path yet, so nothing is shown in the Shopify app yet
    status: 'synthetic_only' as const,
    shopifyReady: false,
  })))
  const store = async (payload: Record<string, unknown>) => {
    const s = await commerceStoreFor(String(payload.orgId))
    if (!s) throw new Error('no active store for this organization')
    return s.store
  }
  registerUndo('commerce.restore_description', async (_db, x) => { const s = await store(x); const ch = await s.setDescription(String(x.productId), String(x.html ?? '')); return { ok: ch.after === String(x.html ?? ''), detail: 'description restored' } })
  registerUndo('commerce.restore_seo', async (_db, x) => { const s = await store(x); const t = x.text ? String(x.text) : null; const ch = await s.setSeoDescription(String(x.productId), t); return { ok: (ch.after || null) === t, detail: 'search description restored' } })
  registerUndo('commerce.restore_inventory_policy', async (_db, x) => { const s = await store(x); const ch = await s.setInventoryPolicy(String(x.variantId), x.policy === 'DENY' ? 'DENY' : 'CONTINUE'); return { ok: ch.after === x.policy, detail: `inventory policy back to ${ch.after}` } })
  registerUndo('commerce.readd_to_collection', async (_db, x) => { const s = await store(x); const ch = await s.addToCollection(String(x.collectionId), String(x.productId)); return { ok: ch.after === 'in collection', detail: 'product back in the collection' } })
  registerUndo('commerce.restore_discount', async (_db, x) => {
    const s = await store(x)
    const out: string[] = []
    let ok = true
    if (x.reactivate) { const ch = await s.activateDiscount(String(x.discountId)); ok &&= ch.after === 'active'; out.push(`discount ${ch.after}`) }
    if (typeof x.announcement === 'string') { const ch = await s.setAnnouncement(x.announcement); ok &&= ch.after === x.announcement; out.push('banner restored') }
    return { ok, detail: out.join('; ') || 'nothing to restore' }
  })
}
registerCommercePack()

/** Run every commerce agent for one sweep of an organization (the router's 15-minute sweep does the same through onEvent). */
export async function sweepCommerce(orgId: string, at = new Date()): Promise<CommerceRunResult[]> {
  const e: AgentEvent = { source: 'sweep', type: 'sweep', orgId, externalId: `sweep:${at.toISOString()}`, occurredAt: at.toISOString(), payload: {} }
  const out: CommerceRunResult[] = []
  for (const a of COMMERCE_AGENTS) out.push(await runCommerceAgent(a.key, e))
  return out
}
