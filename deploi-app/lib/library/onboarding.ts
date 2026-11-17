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
import { acceptorId, legalGateMode, missingAcceptances } from '../legal'
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
// Setup (the customer's first run at /store/setup; /store/onboarding and /store/welcome redirect there):
// business → agreements → products → connect → discovery → done. One path from a new sign-up to a working
// team. The business step is usually done already (the organization is named when it is created at /start).
// Agreements are a step only while LEGAL_GATE is on, and are read from the real acceptances. Discovery reads
// what was connected, shows "We found work your AI team can handle.", sets up the recommended team at drafts
// only (lib/discovery setUpTeam) and the owner grants it. State lives in agencies.onboarding.wizard, so the
// setup is resumable; every step is idempotent. Nothing here grants anything.
//
// The earlier wizard steps "your first agents" (fixed templates) and "first scan" duplicated discovery, which
// reads the store and recommends the agents from what it found; their functions remain for the API.
// =============================================================================================

export type WizardStep = 'business' | 'agreements' | 'products' | 'connect' | 'discover' | 'done'
export type WizardStepState = 'done' | 'current' | 'todo' | 'skipped'
export const WIZARD_STEPS: { key: WizardStep; title: string; body: string }[] = [
  { key: 'business', title: 'Your business', body: 'Your business name and time zone. Schedules and the weekly summary use the time zone.' },
  { key: 'agreements', title: 'Agreements', body: 'Read and accept the agreements before Deploi connects to anything.' },
  { key: 'products', title: 'Choose your products', body: 'Deploi Commerce looks after a Shopify or WooCommerce store. Deploi Office follows up leads, answers mail and chases invoices with HubSpot, Google Calendar and QuickBooks. Choose one or both.' },
  { key: 'connect', title: 'Connect an app', body: 'Connect the store or office tools you chose. Connecting reads data; it authorizes no agent to change anything.' },
  { key: 'discover', title: 'Find the work', body: 'Deploi reads what you connected, lists the problems it found, and recommends an AI team. You set the team up at drafts only and grant each agent.' },
  { key: 'done', title: 'You are set', body: 'Home shows every agent, what waits for you, and a Stop all agents switch.' },
]

/** Agents the old wizard step recommended for each product (kept for its API; discovery now recommends the team). */
export const RECOMMENDED_AGENTS: Record<Product, TemplateKey[]> = { commerce: ['inventory_watcher', 'store_health_checker'], office: [] }
export type CommercePlatform = 'shopify' | 'woocommerce'
export type AgreementsStatus = 'pending' | 'satisfied' | 'skipped'

type WizardState = {
  business?: { name: string; timezone: string; savedAt: string }
  productsChosen?: boolean; commercePlatform?: CommercePlatform | null
  agreements?: AgreementsStatus
  agents?: Record<string, string>; agentsSkipped?: boolean
  discoverSkipped?: boolean
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
  /** connected Office tools and mailboxes */
  office: { connected: string[]; mailboxes: number }
  /** LEGAL_GATE mode and the agreements this person still has to accept (empty when the gate is off) */
  legal: { gate: 'off' | 'draft' | 'enforce'; missing: string[] }
  agreements: AgreementsStatus
  discovery: { ran: boolean; running: boolean; recommended: number; activeAgents: number; waitingAgents: number; skipped: boolean }
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
  const gate = legalGateMode()
  const base = await withActor(actor, async db => {
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
    return { org, w, products, conn, agents }
  })
  const { org, w, products, conn, agents } = base
  // connections, agreements and discovery are read as the service role, for this organization only
  const extra = await admin(async db => {
    const office = await db.query<{ provider: string }>(`select distinct provider from office_connections where org_id = $1 and status = 'active' order by provider`, [orgId])
    const mb = await db.one<{ n: number }>(`select count(*)::int as n from email_accounts where org_id = $1 and status = 'active'`, [orgId])
    const missing = gate === 'off' ? [] : (await missingAcceptances(db, orgId, acceptorId(actor), products.includes('commerce') || !products.includes('office') ? 'commerce' : 'office')).map(d => d.key)
    const run = await db.one<{ status: string; n: number }>(`select status, coalesce(jsonb_array_length(recommendations), 0)::int as n from discovery_runs where org_id = $1 order by started_at desc limit 1`, [orgId])
    const done = await db.one<{ n: number }>(`select coalesce(jsonb_array_length(recommendations), 0)::int as n from discovery_runs where org_id = $1 and status in ('completed','partial') order by started_at desc limit 1`, [orgId])
    const active = await db.one<{ n: number }>(`select count(*)::int as n from discovery_agents d
      left join agents a on d.agent_kind = 'engine' and a.id = d.agent_id left join office_agents o on d.agent_kind = 'office' and o.id = d.agent_id
      where d.org_id = $1 and coalesce(a.status, o.status) = 'active'`, [orgId])
    // agents the team setup created that still wait for the owner's grant (the step offers the grant until none waits)
    const waiting = await db.one<{ n: number }>(`select count(*)::int as n from discovery_agents d
      left join agents a on d.agent_kind = 'engine' and a.id = d.agent_id left join office_agents o on d.agent_kind = 'office' and o.id = d.agent_id
      where d.org_id = $1 and coalesce(a.status, o.status) = 'draft'`, [orgId])
    return { office: office.map(o => o.provider), mailboxes: mb?.n ?? 0, missing, running: run?.status === 'running', ran: Boolean(done), recommended: done?.n ?? 0, activeAgents: active?.n ?? 0, waitingAgents: waiting?.n ?? 0 }
  })
  const commerce = w.productsChosen ? products.includes('commerce') : false
  const officeOn = w.productsChosen ? products.includes('office') : false
  const done: Record<WizardStep, boolean | 'skipped'> = {
    business: Boolean(w.business),
    agreements: gate === 'off' ? 'skipped' : extra.missing.length === 0,
    products: Boolean(w.productsChosen),
    // a connected store counts even before products are chosen; any Office tool or mailbox counts for Office
    connect: w.productsChosen ? (commerce && Boolean(conn)) || (officeOn && (extra.office.length > 0 || extra.mailboxes > 0)) : Boolean(conn),
    // done once an agent works and none the setup created still waits for its grant (or there was nothing to set up)
    discover: w.discoverSkipped ? 'skipped' : extra.ran && ((extra.activeAgents > 0 && extra.waitingAgents === 0) || extra.recommended === 0),
    done: Boolean(w.completedAt),
  }
  const current = WIZARD_STEPS.find(s => !done[s.key])?.key ?? 'done'
  const steps = WIZARD_STEPS.map(s => ({ ...s, state: (done[s.key] === 'skipped' ? 'skipped' : done[s.key] ? 'done' : s.key === current ? 'current' : 'todo') as WizardStepState }))
  return {
    steps, current,
    business: { name: w.business?.name ?? org?.name ?? '', timezone: w.business?.timezone ?? org?.timezone ?? 'UTC', saved: Boolean(w.business) },
    products, productsChosen: Boolean(w.productsChosen), commercePlatform: w.commercePlatform ?? null,
    store: { connected: Boolean(conn), id: conn?.id ?? null, platform: conn?.platform ?? null, name: conn?.name ?? null, synthetic: Boolean(conn?.is_synthetic) },
    office: { connected: extra.office, mailboxes: extra.mailboxes },
    legal: { gate, missing: extra.missing },
    agreements: gate === 'off' ? 'skipped' : extra.missing.length === 0 ? 'satisfied' : 'pending',
    discovery: { ran: extra.ran, running: extra.running, recommended: extra.recommended, activeAgents: extra.activeAgents, waitingAgents: extra.waitingAgents, skipped: Boolean(w.discoverSkipped) },
    agents, agentsSkipped: Boolean(w.agentsSkipped),
    scan: w.scan ?? null, completedAt: w.completedAt ?? null,
    mailboxes: Boolean(emailConfig.agentMailDomain),
  }
}

/** "Not now" on the discovery step (the owner can run discovery any time from Business Insights). */
export async function skipDiscovery(actor: Actor) {
  const orgId = merchantOrg(actor)
  await patchWizard(orgId, { discoverSkipped: true }, actor.label, 'discover_skipped')
  return { discoverSkipped: true }
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
