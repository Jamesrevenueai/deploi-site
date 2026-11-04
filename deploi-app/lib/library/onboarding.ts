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
import { enableProduct, disableProduct, enabledProducts, type Product } from '../products'
import { createAgent } from '../agents/lifecycle'
import { templateByKey, templatePolicy, type TemplateKey } from '../agents/templates'
import { emailConfig } from '../email/config'
import { runScan } from '../engine/scan'
import type { Db } from '../db'

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

// =============================================================================================
// Setup wizard (the customer onboarding at /store/onboarding): business → products → connect →
// agreements → automatic agent setup at drafts only → first scan → done. State lives in
// agencies.onboarding.wizard so it is resumable; every step is idempotent and re-running it never
// creates a second agent. The wizard never grants anything: agents it creates wait for the owner's
// explicit grant through the existing grant API, and their policies are drafts only for every tool.
// =============================================================================================

export type WizardStep = 'business' | 'products' | 'connect' | 'agreements' | 'agents' | 'scan' | 'done'
export type WizardStepState = 'done' | 'current' | 'todo' | 'skipped'
export const WIZARD_STEPS: { key: WizardStep; title: string; body: string }[] = [
  { key: 'business', title: 'Your business', body: 'Your business name and time zone. Schedules and the weekly summary use the time zone.' },
  { key: 'products', title: 'Choose your products', body: 'Deploi Commerce looks after a Shopify or WooCommerce store. Deploi Office follows up leads with HubSpot and Google Calendar. Choose one or both.' },
  { key: 'connect', title: 'Connect your tools', body: 'Connect the store or office tools you chose. Connecting reads data; it authorizes no agent to change anything.' },
  { key: 'agreements', title: 'Agreements', body: 'Read and accept the agreements for the products you chose.' },
  { key: 'agents', title: 'Your first agents', body: 'Deploi sets up the recommended agents for your products at drafts only: they show you the exact change or email and never make or send it. Nothing runs until you grant each one.' },
  { key: 'scan', title: 'First scan', body: 'Deploi reads your store once and lists what it finds. Nothing is changed.' },
  { key: 'done', title: 'You are set', body: 'The Control Room shows every agent, what waits for you, and a Stop all agents switch.' },
]

/** Agents the wizard recommends for each product. Office agents are set up in Deploi Office. */
export const RECOMMENDED_AGENTS: Record<Product, TemplateKey[]> = { commerce: ['inventory_watcher', 'store_health_checker'], office: [] }
export type CommercePlatform = 'shopify' | 'woocommerce'
export type AgreementsStatus = 'pending' | 'satisfied' | 'skipped'

type WizardState = {
  business?: { name: string; timezone: string; savedAt: string }
  productsChosen?: boolean; commercePlatform?: CommercePlatform | null
  agreements?: AgreementsStatus
  agents?: Record<string, string>; agentsSkipped?: boolean
  scan?: { at: string; scanId: string; resourcesScanned: number; issuesOpened: number }
  completedAt?: string
}

export type WizardAgent = {
  key: TemplateKey; name: string; job: string; tools: string[]
  agentId: string | null; status: 'not_created' | 'draft' | 'active' | 'paused' | 'revoked'
  /** permission level of every tool the agent was created with (always drafts only from the wizard) */
  tier: 'draft'
  pending: { policyId: string; policyHash: string; version: number; summary: { grants: string[]; limits: string[]; never: string[] } } | null
  summary: { grants: string[]; limits: string[]; never: string[] } | null
}

export type WizardView = {
  steps: (typeof WIZARD_STEPS[number] & { state: WizardStepState })[]
  current: WizardStep
  business: { name: string; timezone: string; saved: boolean }
  products: Product[]; productsChosen: boolean; commercePlatform: CommercePlatform | null
  store: { connected: boolean; id: string | null; platform: string | null; name: string | null; synthetic: boolean }
  agreements: AgreementsStatus
  agents: WizardAgent[]; agentsSkipped: boolean
  scan: WizardState['scan'] | null
  completedAt: string | null
  mailboxes: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function merchantOrg(actor: Actor): string {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'onboarding belongs to a merchant')
  assertMerchant(actor, actor.orgId)
  return actor.orgId
}

export function validTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

async function readWizard(db: Db, orgId: string): Promise<WizardState> {
  const r = await db.one<{ w: WizardState | null }>(`select onboarding->'wizard' as w from agencies where id = $1`, [orgId])
  return r?.w ?? {}
}

async function patchWizard(orgId: string, patch: Record<string, unknown>, actorLabel: string, event: string) {
  await admin(async db => {
    await db.query(`update agencies set onboarding = jsonb_set(coalesce(onboarding, '{}'::jsonb), '{wizard}', coalesce(onboarding->'wizard', '{}'::jsonb) || $2::jsonb) where id = $1`, [orgId, JSON.stringify(patch)])
    await audit(db, { orgId, entityType: 'library', entityId: 'onboarding', event: `library.onboarding.${event}`, actor: actorLabel, detail: patch })
  })
}

export async function wizardView(actor: Actor): Promise<WizardView> {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'onboarding belongs to a merchant')
  const orgId = actor.orgId
  return withActor(actor, async db => {
    const org = await db.one<{ name: string; timezone: string }>('select name, timezone from agencies where id = $1', [orgId])
    const w = await readWizard(db, orgId)
    const products = await enabledProducts(db, orgId)
    const conn = await db.one<{ id: string; platform: string; is_synthetic: boolean; name: string | null }>(
      `select id, platform, is_synthetic, coalesce(display_name, external_id) as name from store_connections where org_id = $1 and status = 'active' order by (platform = $2) desc, created_at limit 1`,
      [orgId, w.commercePlatform ?? 'shopify'])
    const commerce = w.productsChosen ? products.includes('commerce') : false
    const recommended = commerce ? RECOMMENDED_AGENTS.commerce : []
    const ids = Object.values(w.agents ?? {}).filter(v => UUID.test(v))
    const rows = ids.length ? await db.query<{ id: string; status: string; active_summary: WizardAgent['summary']; p_id: string | null; p_hash: string | null; p_version: number | null; p_summary: WizardAgent['summary'] }>(
      `select a.id, a.status, ap.summary as active_summary, pp.id as p_id, pp.policy_hash as p_hash, pp.version as p_version, pp.summary as p_summary
       from agents a left join agent_policies ap on ap.id = a.active_policy_id
       left join lateral (select id, policy_hash, version, summary from agent_policies where agent_id = a.id and status = 'pending_grant' order by version desc limit 1) pp on true
       where a.id = any($1::uuid[]) and a.status <> 'deleted'`, [ids]) : []
    const byId = new Map(rows.map(r => [r.id, r]))
    const agents: WizardAgent[] = recommended.map(key => {
      const t = templateByKey(key)!
      const id = w.agents?.[key]
      const row = id && UUID.test(id) ? byId.get(id) : undefined
      return {
        key, name: t.name, job: t.job, tools: t.tools, agentId: row?.id ?? null,
        status: (row ? row.status : 'not_created') as WizardAgent['status'], tier: 'draft',
        pending: row?.p_id ? { policyId: row.p_id, policyHash: row.p_hash!, version: row.p_version!, summary: row.p_summary! } : null,
        summary: row?.active_summary ?? row?.p_summary ?? null,
      }
    })
    const done: Record<WizardStep, boolean | 'skipped'> = {
      business: Boolean(w.business),
      products: Boolean(w.productsChosen),
      // a connected store counts even before products are chosen; Office-only needs no store here (its tools connect in Deploi Office)
      connect: Boolean(conn) || (Boolean(w.productsChosen) && !commerce),
      agreements: w.agreements === 'satisfied' ? true : w.agreements === 'skipped' ? 'skipped' : false,
      agents: !w.productsChosen ? false : !recommended.length || !conn ? 'skipped' : w.agentsSkipped ? 'skipped'
        : agents.every(a => a.status === 'active' || a.status === 'paused'),
      scan: !w.productsChosen ? false : !conn || !commerce ? 'skipped' : Boolean(w.scan),
      done: Boolean(w.completedAt),
    }
    const current = WIZARD_STEPS.find(s => !done[s.key])?.key ?? 'done'
    const steps = WIZARD_STEPS.map(s => ({ ...s, state: (done[s.key] === 'skipped' ? 'skipped' : done[s.key] ? 'done' : s.key === current ? 'current' : 'todo') as WizardStepState }))
    return {
      steps, current,
      business: { name: w.business?.name ?? org?.name ?? '', timezone: w.business?.timezone ?? org?.timezone ?? 'UTC', saved: Boolean(w.business) },
      products, productsChosen: Boolean(w.productsChosen), commercePlatform: w.commercePlatform ?? null,
      store: { connected: Boolean(conn), id: conn?.id ?? null, platform: conn?.platform ?? null, name: conn?.name ?? null, synthetic: Boolean(conn?.is_synthetic) },
      agreements: w.agreements ?? 'pending',
      agents, agentsSkipped: Boolean(w.agentsSkipped),
      scan: w.scan ?? null, completedAt: w.completedAt ?? null,
      mailboxes: Boolean(emailConfig.agentMailDomain),
    }
  })
}

export async function saveBusiness(actor: Actor, input: { name: unknown; timezone: unknown }) {
  const orgId = merchantOrg(actor)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : ''
  if (!name || name.length > 120) throw new LibraryError('invalid_input', 'business name must be 1 to 120 characters')
  if (!validTimezone(timezone)) throw new LibraryError('invalid_input', 'choose a valid time zone')
  await admin(db => db.query('update agencies set name = $2, timezone = $3 where id = $1', [orgId, name, timezone]))
  await patchWizard(orgId, { business: { name, timezone, savedAt: new Date().toISOString() } }, actor.label, 'business')
  return { name, timezone }
}

/** Enable the chosen products (org_products via enableProduct) and disable the others. At least one. */
export async function chooseProducts(actor: Actor, input: { commerce: unknown; office: unknown; platform?: unknown }) {
  const orgId = merchantOrg(actor)
  const want: Record<Product, boolean> = { commerce: input.commerce === true, office: input.office === true }
  if (!want.commerce && !want.office) throw new LibraryError('invalid_input', 'choose at least one product')
  const platform: CommercePlatform | null = want.commerce ? (input.platform === 'woocommerce' ? 'woocommerce' : 'shopify') : null
  await admin(async db => {
    for (const p of Object.keys(want) as Product[]) {
      if (want[p]) await enableProduct(db, orgId, p, actor.label)
      else await disableProduct(db, orgId, p)
    }
  })
  await patchWizard(orgId, { productsChosen: true, commercePlatform: platform }, actor.label, 'products')
  return { products: (Object.keys(want) as Product[]).filter(p => want[p]), commercePlatform: platform }
}

export async function setAgreements(actor: Actor, status: unknown) {
  const orgId = merchantOrg(actor)
  if (status !== 'satisfied' && status !== 'skipped') throw new LibraryError('invalid_input', 'status must be satisfied or skipped')
  await patchWizard(orgId, { agreements: status }, actor.label, 'agreements')
  return { agreements: status }
}

/** The raw policy the wizard creates an agent with: the template's, with every tool forced to drafts only. */
export function draftsOnlyTemplatePolicy(key: TemplateKey, input: { connectionId: string; timezone: string; notify: string | null; withEmail: boolean }): Record<string, unknown> {
  const p = templatePolicy(key, { connectionId: input.connectionId, timezone: input.timezone, notify: input.notify })
  const out: Record<string, unknown> = { ...p, approvalMode: 'draft', validUntil: null }
  if (input.withEmail && p.email && input.notify) out.email = { ...(p.email as Record<string, unknown>), permission: 'draft', validUntil: null }
  else delete out.email
  assertDraftsOnly(out)
  return out
}

/** Hard check, in code: the wizard never creates anything above drafts only. */
export function assertDraftsOnly(p: Record<string, unknown>) {
  const email = p.email as Record<string, unknown> | undefined
  if (p.approvalMode !== 'draft' || (email && email.permission !== 'draft')) throw new LibraryError('forbidden', 'automatic setup creates agents at drafts only')
}

export type AutoSetupResult = { created: string[]; existing: string[]; failed: { key: string; message: string }[] }

/**
 * Create the recommended agents for the chosen products, at drafts only, each waiting for the owner's grant.
 * Idempotent and safe under concurrent calls: each template is claimed in the wizard state with a
 * compare-and-set before it is created; an agent that still exists is never created again.
 */
export async function autoSetupAgents(actor: Actor): Promise<AutoSetupResult> {
  const orgId = merchantOrg(actor)
  const v = await wizardView(actor)
  if (!v.productsChosen) throw new LibraryError('needs_setup', 'choose your products first', { step: 'products' })
  const out: AutoSetupResult = { created: [], existing: [], failed: [] }
  if (!v.store.connected || !v.products.includes('commerce')) return out
  const connectionId = v.store.id!
  const notify = actor.kind === 'profile' ? actor.session.email.toLowerCase() : null
  await admin(db => db.query(`update agencies set onboarding = jsonb_set(coalesce(onboarding, '{}'::jsonb), '{wizard}', coalesce(onboarding->'wizard', '{}'::jsonb) || jsonb_build_object('agents', coalesce(onboarding->'wizard'->'agents', '{}'::jsonb))) where id = $1`, [orgId]))
  for (const key of RECOMMENDED_AGENTS.commerce) {
    const t = templateByKey(key)!
    const prev = await admin(db => readWizard(db, orgId)).then(w => w.agents?.[key] ?? null)
    if (prev && UUID.test(prev)) {
      const alive = await admin(db => db.one<{ id: string }>(`select id from agents where id = $1 and org_id = $2 and status <> 'deleted'`, [prev, orgId]))
      if (alive) { out.existing.push(key); continue }
    }
    // another request is creating it right now (claims older than two minutes are abandoned)
    if (prev?.startsWith('pending:') && Date.now() - Date.parse(prev.slice(8)) < 120_000) { out.existing.push(key); continue }
    const claim = `pending:${new Date().toISOString()}`
    const won = await admin(db => db.one<{ id: string }>(
      `update agencies set onboarding = jsonb_set(onboarding, '{wizard,agents}', (onboarding->'wizard'->'agents') || jsonb_build_object($2::text, $3::text))
       where id = $1 and (onboarding->'wizard'->'agents'->>$2) is not distinct from $4 returning id`, [orgId, key, claim, prev]))
    if (!won) { out.existing.push(key); continue }
    try {
      const withEmail = Boolean(emailConfig.agentMailDomain) && Boolean(notify) && t.mailbox
      const policy = draftsOnlyTemplatePolicy(key, { connectionId, timezone: v.business.timezone || 'UTC', notify, withEmail })
      const r = await createAgent(actor, { name: t.name, taskText: t.job, policy, mailbox: withEmail && Boolean(policy.email), templateKey: key })
      await admin(db => db.query(`update agencies set onboarding = jsonb_set(onboarding, '{wizard,agents}', (onboarding->'wizard'->'agents') || jsonb_build_object($2::text, $3::text)) where id = $1`, [orgId, key, r.agentId]))
      out.created.push(key)
    } catch (e) {
      await admin(db => db.query(`update agencies set onboarding = jsonb_set(onboarding, '{wizard,agents}', (onboarding->'wizard'->'agents') - $2::text) where id = $1 and onboarding->'wizard'->'agents'->>$2 = $3`, [orgId, key, claim]))
      out.failed.push({ key, message: (e as Error).message })
    }
  }
  await admin(db => audit(db, { orgId, entityType: 'library', entityId: 'onboarding', event: 'library.onboarding.agents_set_up', actor: actor.label, detail: { ...out, tier: 'draft' } }))
  return out
}

export async function skipAgents(actor: Actor) {
  const orgId = merchantOrg(actor)
  await patchWizard(orgId, { agentsSkipped: true }, actor.label, 'agents_skipped')
  return { agentsSkipped: true }
}

/** The first read of the store. Read only: a scan records issues and proposals, it never writes to the store. */
export async function firstScan(actor: Actor) {
  const orgId = merchantOrg(actor)
  const v = await wizardView(actor)
  if (!v.store.connected) throw new LibraryError('needs_setup', 'connect a store first', { step: 'connect' })
  const r = await runScan(v.store.id!, { trigger: 'manual', actor: actor.label })
  const scan = { at: new Date().toISOString(), scanId: r.scanId, resourcesScanned: r.resourcesScanned, issuesOpened: r.issuesOpened }
  await patchWizard(orgId, { scan }, actor.label, 'first_scan')
  return scan
}

export async function completeWizard(actor: Actor) {
  const orgId = merchantOrg(actor)
  const v = await wizardView(actor)
  const missing = v.steps.filter(s => s.key !== 'done' && s.state !== 'done' && s.state !== 'skipped').map(s => s.key)
  if (missing.length) throw new LibraryError('needs_setup', `finish these steps first: ${missing.join(', ')}`, { step: missing[0] })
  const completedAt = v.completedAt ?? new Date().toISOString()
  await patchWizard(orgId, { completedAt }, actor.label, 'wizard_completed')
  return { completed: true, completedAt }
}
