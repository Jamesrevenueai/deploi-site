/**
 * Private-beta onboarding: connect a store, choose the tier to trial, switch on the first agents.
 * State lives in agencies.onboarding so a merchant can leave and come back. Nothing here changes the
 * Shopify app configuration: the "connect" step is the existing install flow.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { LIBRARY, type TierKey } from './config'
import { LibraryError } from './errors'
import { orgTier } from './switches'

export type OnboardingStep = 'connect' | 'tier' | 'agents' | 'done'
export const STEPS: { key: OnboardingStep; title: string; body: string }[] = [
  { key: 'connect', title: 'Connect your store', body: 'Install Deploi on your Shopify store. It reads products and inventory; nothing is changed until you approve it.' },
  { key: 'tier', title: 'Choose a plan to trial', body: 'The plan decides which agents you can switch on. Private beta is free; prices are coming soon and you will approve any charge first.' },
  { key: 'agents', title: 'Switch on your first agents', body: 'Every agent starts at draft-for-approval. Nothing happens in your store until you approve it.' },
  { key: 'done', title: 'You are set', body: 'Your team is on the dashboard. Approvals wait in each agent\'s queue; the weekly summary arrives on Mondays.' },
]

export type OnboardingView = {
  steps: typeof STEPS; current: OnboardingStep; state: Record<string, unknown>
  store: { connected: boolean; synthetic: boolean; name: string | null }; tier: TierKey; agentsOn: number; tiers: typeof LIBRARY.tiers
}

export async function onboardingView(actor: Actor): Promise<OnboardingView> {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'onboarding belongs to a merchant')
  const orgId = actor.orgId
  return withActor(actor, async db => {
    const org = await db.one<{ onboarding: Record<string, unknown> }>('select onboarding from agencies where id = $1', [orgId])
    const conn = await db.one<{ is_synthetic: boolean; name: string | null }>(`select is_synthetic, coalesce(display_name, external_id) as name from store_connections where org_id = $1 and status = 'active' order by created_at limit 1`, [orgId])
    const on = await db.one<{ n: string }>('select count(*)::text as n from library_switches where org_id = $1 and enabled', [orgId])
    const state = org?.onboarding ?? {}
    const tier = await orgTier(db, orgId)
    const agentsOn = Number(on?.n ?? 0)
    const current: OnboardingStep = state.completedAt ? 'done' : !conn ? 'connect' : !state.tierChosen ? 'tier' : agentsOn === 0 ? 'agents' : 'done'
    return { steps: STEPS, current, state, store: { connected: Boolean(conn), synthetic: Boolean(conn?.is_synthetic), name: conn?.name ?? null }, tier, agentsOn, tiers: LIBRARY.tiers }
  })
}

export async function completeOnboarding(actor: Actor) {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'onboarding belongs to a merchant')
  assertMerchant(actor, actor.orgId)
  const v = await onboardingView(actor)
  if (!v.store.connected) throw new LibraryError('needs_setup', 'connect a store first', { step: 'connect' })
  if (!v.state.tierChosen) throw new LibraryError('needs_setup', 'choose a plan first', { step: 'tier' })
  await admin(async db => {
    await db.query(`update agencies set onboarding = onboarding || jsonb_build_object('completedAt', now(), 'storeConnected', true, 'agentsSwitchedOn', $2::boolean) where id = $1`, [actor.orgId, v.agentsOn > 0])
    await audit(db, { orgId: actor.orgId, entityType: 'library', entityId: 'onboarding', event: 'library.onboarding.completed', actor: actor.label, detail: { tier: v.tier, agents_on: v.agentsOn } })
  })
  return { completed: true }
}
