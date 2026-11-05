/**
 * From recommendations to a working AI team.
 *  - aggregateRecommendations: one entry per template across every detector, ordered by value (the number
 *    of findings behind it), each with a plain reason, what it monitors, its schedule, its approval rule
 *    (drafts only), its safe limits, and what the owner must still supply (never guessed).
 *  - createTeam (one click): creates every recommended agent that can be created now, at drafts only for
 *    every tool, idempotently (a template already set up, by discovery, the setup wizard or by hand, is
 *    never created again). Each agent waits for the owner's grant; its policy summary and hash are returned.
 *  - grantTeam ("grant all shown"): one request carrying the hash of every policy the owner was shown; each
 *    is granted only if its hash still matches the pending version and it is drafts only. Anything wider
 *    is granted from the agent's own page.
 * Templates set up elsewhere (other domains) plug in with registerTemplateSetup.
 */
import { admin, type Db } from '../db'
import { assertMerchant, type Actor } from '../engine/actor'
import { audit } from '../engine/audit'
import { EngineError, isEngineError } from '../engine/errors'
import { createAgent, grantPolicy } from '../agents/lifecycle'
import { templateByKey, type TemplateKey } from '../agents/templates'
import { draftsOnlyTemplatePolicy } from '../library/onboarding'
import { emailConfig } from '../email/config'
import { createOfficeAgent, grantOfficePolicy } from '../office/agents'
import { officeTemplate, officeTemplatePolicy } from '../office/templates'
import type { OfficeKind } from '../office/policy'
import { hasProduct } from '../products'
import type { Suite } from '../cases'
import type { ConnectionRow } from '../engine/types'
import type { AgentRecommendation } from './registry'
import { activeStores } from './store'

export const DRAFTS_ONLY = 'Drafts only: it shows you each change or email it would make. Nothing is changed in your store or sent until you approve it.'

export type PolicySummary = { grants: string[]; limits: string[]; never: string[] }
export type AgentKind = 'engine' | 'office'
type MerchantActor = Exclude<Actor, { kind: 'staff' }>

export type SetupContext = {
  actor: MerchantActor; orgId: string; timezone: string; orgName: string; notify: string | null
  store: ConnectionRow | null; officeEnabled: boolean
  office: { hubspot: string | null; calendar: string | null; mailbox: string | null; quickbooks: string | null }
}

export type TemplateSetup = {
  agentKind: AgentKind
  suite: Suite
  name: string
  monitors: string
  schedule: string
  limits: string[]
  /** what is missing before the agent can be created ([] = ready); never filled in by guessing */
  blockers(ctx: SetupContext): string[]
  /** an agent for this template the organization already has (set up by the wizard or by hand) */
  findExisting(db: Db, ctx: SetupContext): Promise<string | null>
  create(ctx: SetupContext): Promise<{ agentId: string }>
}

const setups = new Map<string, TemplateSetup>()
/** Other domains register automatic setup for their templates here (drafts only for every tool). */
export function registerTemplateSetup(template: string, s: TemplateSetup) { setups.set(template, s) }
export const templateSetup = (template: string) => setups.get(template) ?? null

// ------------------------------------------------------------------ built-in templates

const ENGINE_COPY: Record<TemplateKey, { monitors: string; schedule: string; limits: string[] }> = {
  inventory_watcher: {
    monitors: 'Inventory: oversold items, items set to keep selling at zero stock, and low stock.',
    schedule: 'Every day at 07:00 (your time zone)',
    limits: ['At most 25 proposed changes per run and 100 per day', 'Items tagged pre-order or backorder are left alone', 'Never changes stock quantities'],
  },
  store_health_checker: {
    monitors: 'The whole store, once a week: overselling and oversold items, in one health report.',
    schedule: 'Once a week',
    limits: ['At most 25 proposed changes per run and 100 per day', 'Reports only; changes nothing'],
  },
  supplier_chaser: {
    monitors: 'Items with 2 or fewer available: drafts one restock request per supplier and one follow-up.',
    schedule: 'Every day at 08:00 (your time zone)',
    limits: ['At most 5 emails per run and 10 per day', 'Only to the supplier addresses you give it', 'Stops once the supplier replies'],
  },
  competitor_watcher: {
    monitors: "Competitor stores' public pages: new products, price changes, discounts, availability.",
    schedule: 'Every day at 07:30 (your time zone)',
    limits: ['Reads public pages only', 'Never guesses their sales'],
  },
}

async function wizardAgent(db: Db, orgId: string, key: string): Promise<string | null> {
  const r = await db.one<{ id: string | null }>(`select onboarding->'wizard'->'agents'->>$2 as id from agencies where id = $1`, [orgId, key])
  return r?.id && /^[0-9a-f-]{36}$/i.test(r.id) ? r.id : null
}

function engineSetup(key: TemplateKey): TemplateSetup {
  const t = templateByKey(key)!
  const copy = ENGINE_COPY[key]
  return {
    agentKind: 'engine', suite: 'commerce', name: t.name, ...copy,
    blockers: ctx => [
      ...(ctx.store ? [] : ['a connected store']),
      ...(key === 'supplier_chaser' ? ["your supplier's email address"] : []),
      ...(key === 'competitor_watcher' ? ['the competitor store addresses'] : []),
    ],
    async findExisting(db, ctx) {
      const fromWizard = await wizardAgent(db, ctx.orgId, key)
      const r = await db.one<{ id: string }>(
        `select id from agents where org_id = $1 and status not in ('deleted','revoked') and (id = $2::uuid or lower(name) = lower($3)) order by (id = $2::uuid) desc, created_at limit 1`,
        [ctx.orgId, fromWizard, t.name])
      return r?.id ?? null
    },
    async create(ctx) {
      const withEmail = Boolean(emailConfig.agentMailDomain) && Boolean(ctx.notify) && t.mailbox
      const policy = draftsOnlyTemplatePolicy(key, { connectionId: ctx.store!.id, timezone: ctx.timezone, notify: ctx.notify, withEmail })
      const r = await createAgent(ctx.actor, { name: t.name, taskText: t.job, policy, mailbox: withEmail && Boolean(policy.email), templateKey: key })
      return { agentId: r.agentId }
    },
  }
}

const OFFICE_COPY: Record<OfficeKind, { monitors: string; schedule: string; limits: string[] }> = {
  lead_followup: { monitors: 'New HubSpot leads: drafts a first email and follow-ups until they reply.', schedule: 'Every hour', limits: ['At most 20 emails per day', 'No emails between 19:00 and 08:00', 'Stops on reply, unsubscribe or opt-out'] },
  meeting_scheduler: { monitors: 'Leads asking to meet: proposes three free times from your calendar.', schedule: 'Every hour', limits: ['At most 20 emails per day', 'Business hours only'] },
  crm_updater: { monitors: 'Emails and meetings, logged as notes on the HubSpot contact.', schedule: 'Every hour', limits: ['Moves stages only by the rules you set'] },
  customer_reply: { monitors: 'Incoming replies: sorted, with a drafted answer for each.', schedule: 'Every hour', limits: ['At most 20 emails per day', 'No emails between 19:00 and 08:00'] },
  accounts_receivable: { monitors: 'Overdue QuickBooks invoices: drafts reminders to the invoice\'s billing address and checks QuickBooks for payment.', schedule: 'Every day', limits: ['Reminders only to the billing email on the invoice', 'Stops on a dispute and asks you', 'Counts as paid only when QuickBooks shows a zero balance', 'Never writes to QuickBooks'] },
}
const OFFICE_NEED: Record<'hubspot' | 'calendar' | 'mailbox' | 'quickbooks', string> = { hubspot: 'a connected HubSpot account', calendar: 'a connected Google Calendar', mailbox: 'a mailbox for Deploi Office', quickbooks: 'a connected QuickBooks company' }

function officeSetup(kind: OfficeKind): TemplateSetup {
  const t = officeTemplate(kind)!
  return {
    agentKind: 'office', suite: 'office', name: t.name, ...OFFICE_COPY[kind],
    blockers: ctx => [...(ctx.officeEnabled ? [] : ['Deploi Office switched on']), ...t.needs.filter(n => !ctx.office[n]).map(n => OFFICE_NEED[n])],
    async findExisting(db, ctx) {
      return (await db.one<{ id: string }>(`select id from office_agents where org_id = $1 and kind = $2 and status not in ('deleted','revoked') order by created_at limit 1`, [ctx.orgId, kind]))?.id ?? null
    },
    async create(ctx) {
      const needs = new Set(t.needs)
      const policy = officeTemplatePolicy(kind, {
        hubspotConnectionId: needs.has('hubspot') ? ctx.office.hubspot : null, calendarConnectionId: needs.has('calendar') ? ctx.office.calendar : null,
        mailboxAccountId: needs.has('mailbox') ? ctx.office.mailbox : null, quickbooksConnectionId: needs.has('quickbooks') ? ctx.office.quickbooks : null, timezone: ctx.timezone, senderName: ctx.orgName,
      })
      const r = await createOfficeAgent(ctx.actor, { kind, name: t.name, policy })
      return { agentId: r.agentId }
    },
  }
}

for (const k of ['inventory_watcher', 'store_health_checker', 'supplier_chaser', 'competitor_watcher'] as TemplateKey[]) registerTemplateSetup(k, engineSetup(k))
for (const k of ['lead_followup', 'meeting_scheduler', 'crm_updater', 'customer_reply', 'accounts_receivable'] as OfficeKind[]) registerTemplateSetup(k, officeSetup(k))

// ------------------------------------------------------------------ aggregation

export type TeamRecommendation = {
  template: string; suite: Suite; name: string
  /** the plain reason (the strongest one), and every detector's reason */
  reason: string; reasons: string[]
  findings: number; detectors: string[]
  monitors: string | null; schedule: string | null; approval: string; limits: string[]
  /** what the owner must still supply (union of every detector's needs and the setup's blockers) */
  needs: string[]
  /** automatic: one-click setup can create it; manual: set it up from its own page */
  setup: 'automatic' | 'manual'
}

export type RecommendationInput = { rec: AgentRecommendation; findings: number; detector: string }

export function aggregateRecommendations(items: RecommendationInput[]): TeamRecommendation[] {
  const by = new Map<string, { recs: RecommendationInput[] }>()
  for (const i of items) {
    if (!i.rec?.template) continue
    const e = by.get(i.rec.template) ?? { recs: [] }
    e.recs.push(i)
    by.set(i.rec.template, e)
  }
  const order = [...setups.keys()]
  const out: TeamRecommendation[] = [...by.entries()].map(([template, { recs }]) => {
    const s = setups.get(template)
    const sorted = [...recs].sort((a, b) => b.findings - a.findings)
    return {
      template, suite: s?.suite ?? sorted[0].rec.suite, name: s?.name ?? sorted[0].rec.name,
      reason: sorted[0].rec.reason, reasons: [...new Set(sorted.map(r => r.rec.reason))],
      findings: recs.reduce((n, r) => n + r.findings, 0), detectors: [...new Set(sorted.map(r => r.detector))],
      monitors: s?.monitors ?? null, schedule: s?.schedule ?? null, approval: DRAFTS_ONLY, limits: s?.limits ?? [],
      needs: [...new Set(recs.flatMap(r => r.rec.needs ?? []))],
      setup: s ? 'automatic' : 'manual',
    }
  })
  return out.sort((a, b) => b.findings - a.findings || (order.indexOf(a.template) >>> 0) - (order.indexOf(b.template) >>> 0) || a.name.localeCompare(b.name))
}

// ------------------------------------------------------------------ setup state

export type TeamAgentState = {
  agentKind: AgentKind; agentId: string; status: string
  /** the version waiting for the owner's grant: what "grant" must carry */
  pending: { policyId: string; policyHash: string; version: number; summary: PolicySummary; draftsOnly: boolean } | null
  summary: PolicySummary | null
}

type PolicyLite = { id: string; policy_hash: string; version: number; summary: PolicySummary; policy: Record<string, unknown> }

/** Every tool at drafts only (engine: approvalMode and email permission; Office: email, calendar and CRM tiers). */
export function isDraftsOnly(kind: AgentKind, p: Record<string, unknown>): boolean {
  if (kind === 'engine') {
    const email = p.email as { permission?: string } | undefined
    return p.approvalMode === 'draft' && (!email || email.permission === 'draft')
  }
  return (['email', 'calendar', 'crm'] as const).every(t => { const v = p[t] as { tier?: string } | null | undefined; return !v || v.tier === 'draft' })
}

export async function agentState(db: Db, orgId: string, kind: AgentKind, agentId: string): Promise<TeamAgentState | null> {
  const agents = kind === 'engine' ? 'agents' : 'office_agents'
  const policies = kind === 'engine' ? 'agent_policies' : 'office_agent_policies'
  const a = await db.one<{ id: string; status: string; active_policy_id: string | null }>(`select id, status, active_policy_id from ${agents} where id = $1 and org_id = $2`, [agentId, orgId])
  if (!a || a.status === 'deleted') return null
  const pending = await db.one<PolicyLite>(`select id, policy_hash, version, summary, policy from ${policies} where agent_id = $1 and status = 'pending_grant' order by version desc limit 1`, [agentId])
  const active = a.active_policy_id ? await db.one<{ summary: PolicySummary }>(`select summary from ${policies} where id = $1`, [a.active_policy_id]) : null
  return {
    agentKind: kind, agentId, status: a.status,
    pending: pending ? { policyId: pending.id, policyHash: pending.policy_hash, version: pending.version, summary: pending.summary, draftsOnly: isDraftsOnly(kind, pending.policy) } : null,
    summary: active?.summary ?? pending?.summary ?? null,
  }
}

/** The agents discovery set up (or linked) for this organization, by template. */
export async function teamAgents(db: Db, orgId: string): Promise<Map<string, TeamAgentState>> {
  const rows = await db.query<{ template: string; agent_kind: AgentKind; agent_id: string | null }>(`select template, agent_kind, agent_id from discovery_agents where org_id = $1 and agent_id is not null`, [orgId])
  const out = new Map<string, TeamAgentState>()
  for (const r of rows) { const s = await agentState(db, orgId, r.agent_kind, r.agent_id!); if (s) out.set(r.template, s) }
  return out
}

function merchantOrg(actor: Actor): MerchantActor {
  if (actor.kind === 'staff') throw new EngineError('forbidden', "Deploi staff can view but not set up a customer's agents")
  assertMerchant(actor, actor.orgId)
  return actor
}

async function setupContext(actor: MerchantActor): Promise<SetupContext> {
  return admin(async db => {
    const org = await db.one<{ name: string; timezone: string | null }>('select name, timezone from agencies where id = $1', [actor.orgId])
    const store = (await activeStores(db, actor.orgId))[0] ?? null
    const conn = async (provider: string) => (await db.one<{ id: string }>(`select id from office_connections where org_id = $1 and provider = $2 and status = 'active' order by connected_at limit 1`, [actor.orgId, provider]))?.id ?? null
    const mailbox = (await db.one<{ id: string }>(
      `select id from email_accounts where org_id = $1 and status = 'active' and (office_mailbox or (provider <> 'deploi' and agent_id is null)) order by office_mailbox desc, connected_at limit 1`, [actor.orgId]))?.id ?? null
    return {
      actor, orgId: actor.orgId, timezone: org?.timezone || store?.timezone || 'UTC', orgName: (org?.name || 'The team').slice(0, 80),
      notify: actor.kind === 'profile' ? actor.session.email.toLowerCase() : null, store,
      officeEnabled: await hasProduct(db, actor.orgId, 'office'),
      office: { hubspot: await conn('hubspot'), calendar: await conn('google_calendar'), mailbox, quickbooks: await conn('quickbooks') },
    }
  })
}

// ------------------------------------------------------------------ one-click setup

export type TeamSetupItem = {
  template: string; name: string
  status: 'created' | 'existing' | 'blocked' | 'manual' | 'in_progress' | 'failed'
  needs: string[]; message: string | null
  agent: TeamAgentState | null
}

const CLAIM_TTL_S = 120

/** Create every recommended agent that can be created now, at drafts only. Idempotent; never duplicates. */
export async function createTeam(actor: Actor, recommendations: TeamRecommendation[]): Promise<TeamSetupItem[]> {
  const m = merchantOrg(actor)
  const ctx = await setupContext(m)
  const out: TeamSetupItem[] = []
  for (const rec of recommendations) {
    const s = setups.get(rec.template)
    const base = { template: rec.template, name: rec.name }
    if (!s) { out.push({ ...base, status: 'manual', needs: rec.needs, message: 'Set this agent up from its own page.', agent: null }); continue }
    // already linked, or an agent for this template exists (wizard, by hand): link it, never create a second
    const linked = await admin(async db => {
      const row = await db.one<{ agent_id: string | null; agent_kind: AgentKind; fresh: boolean }>(
        `select agent_id, agent_kind, claimed_at > now() - make_interval(secs => $3) as fresh from discovery_agents where org_id = $1 and template = $2`, [m.orgId, rec.template, CLAIM_TTL_S])
      if (row?.agent_id) {
        const st = await agentState(db, m.orgId, row.agent_kind, row.agent_id)
        if (st && st.status !== 'revoked') return { state: st }
        await db.query('delete from discovery_agents where org_id = $1 and template = $2 and agent_id = $3', [m.orgId, rec.template, row.agent_id])
      } else if (row && row.fresh) return { busy: true as const }
      const existing = await s.findExisting(db, ctx)
      if (existing) {
        await db.query(`insert into discovery_agents (org_id, template, agent_kind, agent_id, created_by) values ($1,$2,$3,$4,$5)
          on conflict (org_id, template) do update set agent_id = excluded.agent_id, agent_kind = excluded.agent_kind`, [m.orgId, rec.template, s.agentKind, existing, m.label])
        return { state: await agentState(db, m.orgId, s.agentKind, existing) }
      }
      return null
    })
    if (linked && 'busy' in linked) { out.push({ ...base, status: 'in_progress', needs: [], message: 'Another request is setting this agent up.', agent: null }); continue }
    if (linked?.state) { out.push({ ...base, status: 'existing', needs: [], message: null, agent: linked.state }); continue }
    const blockers = s.blockers(ctx)
    if (blockers.length) { out.push({ ...base, status: 'blocked', needs: blockers, message: `Needs ${blockers.join(', ')} first.`, agent: null }); continue }
    // claim the template (one creator at a time; an abandoned claim expires)
    const won = await admin(db => db.one<{ template: string }>(
      `insert into discovery_agents (org_id, template, agent_kind, created_by) values ($1,$2,$3,$4)
       on conflict (org_id, template) do update set claimed_at = now(), created_by = excluded.created_by
         where discovery_agents.agent_id is null and discovery_agents.claimed_at <= now() - make_interval(secs => $5)
       returning template`, [m.orgId, rec.template, s.agentKind, m.label, CLAIM_TTL_S]))
    if (!won) { out.push({ ...base, status: 'in_progress', needs: [], message: 'Another request is setting this agent up.', agent: null }); continue }
    try {
      const r = await s.create(ctx)
      const state = await admin(async db => {
        await db.query('update discovery_agents set agent_id = $3 where org_id = $1 and template = $2', [m.orgId, rec.template, r.agentId])
        return agentState(db, m.orgId, s.agentKind, r.agentId)
      })
      out.push({ ...base, status: 'created', needs: [], message: null, agent: state })
    } catch (e) {
      await admin(db => db.query('delete from discovery_agents where org_id = $1 and template = $2 and agent_id is null', [m.orgId, rec.template]))
      out.push({ ...base, status: 'failed', needs: [], message: (e as Error).message.slice(0, 300), agent: null })
    }
  }
  await admin(db => audit(db, { orgId: m.orgId, entityType: 'org', entityId: m.orgId, event: 'discovery.team_set_up', actor: m.label,
    detail: { items: out.map(i => ({ template: i.template, status: i.status, agent_id: i.agent?.agentId ?? null })), tier: 'draft' } }))
  return out
}

// ------------------------------------------------------------------ grant all shown

export type GrantRequest = { agentId: string; policyId?: string | null; policyHash: string }
export type GrantResult = { agentId: string; template: string | null; ok: boolean; code?: string; message?: string; status?: string }

/**
 * Grant every policy the owner was shown, each only if the hash shown is still the pending version's and
 * it is drafts only. One mismatch refuses that agent only; the others are granted.
 */
export async function grantTeam(actor: Actor, grants: GrantRequest[]): Promise<GrantResult[]> {
  const m = merchantOrg(actor)
  if (!Array.isArray(grants) || !grants.length) throw new EngineError('invalid_input', 'list the agents you reviewed, each with the hash you were shown')
  if (grants.length > 25) throw new EngineError('invalid_input', 'at most 25 agents at once')
  const out: GrantResult[] = []
  for (const g of grants) {
    const agentId = String(g?.agentId ?? '')
    const hash = String(g?.policyHash ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(agentId) || !hash) { out.push({ agentId, template: null, ok: false, code: 'invalid_input', message: 'needs an agent id and the policy hash you were shown' }); continue }
    const row = await admin(db => db.one<{ template: string; agent_kind: AgentKind }>('select template, agent_kind from discovery_agents where org_id = $1 and agent_id = $2', [m.orgId, agentId]))
    if (!row) { out.push({ agentId, template: null, ok: false, code: 'not_found', message: 'this agent is not part of the recommended team; grant it from its own page' }); continue }
    const st = await admin(db => agentState(db, m.orgId, row.agent_kind, agentId))
    if (!st) { out.push({ agentId, template: row.template, ok: false, code: 'not_found', message: 'agent not found' }); continue }
    if (!st.pending) { out.push({ agentId, template: row.template, ok: false, code: 'not_pending', message: 'nothing is waiting for a grant', status: st.status }); continue }
    if ((g.policyId && g.policyId !== st.pending.policyId) || st.pending.policyHash !== hash) {
      out.push({ agentId, template: row.template, ok: false, code: 'hash_mismatch', message: 'the authorization you reviewed is not the current version; review it again', status: st.status }); continue
    }
    if (!st.pending.draftsOnly) { out.push({ agentId, template: row.template, ok: false, code: 'forbidden', message: 'this version allows more than drafts; grant it from the agent\'s own page', status: st.status }); continue }
    try {
      if (row.agent_kind === 'engine') await grantPolicy(m, agentId, st.pending.policyId, hash)
      else await grantOfficePolicy(m, agentId, st.pending.policyId, hash)
      out.push({ agentId, template: row.template, ok: true, status: 'active' })
    } catch (e) {
      out.push({ agentId, template: row.template, ok: false, code: isEngineError(e) ? e.code : 'failed', message: (e as Error).message.slice(0, 300), status: st.status })
    }
  }
  return out
}
