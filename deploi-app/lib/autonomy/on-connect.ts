/**
 * Autonomy on connect: the moment a system is connected, Deploi starts finding problems and fixing them, and brings
 * what it found to the owner (the owner never has to go first).
 *
 * onConnected(input) is called by every place a connection becomes active (Shopify install, WooCommerce connect,
 * Office connections: QuickBooks, HubSpot, Salesforce, Pipedrive, Zoho, Google Calendar; email accounts: Gmail,
 * Outlook, the Deploi office mailbox; the Buildium key). It never throws (a connection must not fail because of it)
 * and is cheap; it runs in its own transaction after the connection committed:
 *   1. packs turn on by themselves: when the owner never chose a business type, it is inferred from what was
 *      connected (Shopify/WooCommerce -> store, Buildium -> property_manager, anything else -> office) and recorded
 *      as source 'inferred'. An owner's choice (source 'owner') is never changed (lib/packs/settings.ts);
 *   2. one autonomy_connects row per organization and connection (a repeated connect event does nothing new) and one
 *      durable job `autonomy.connect` (idempotency key connect:<connection id>).
 *
 * The job (runOnConnect) then, without any click:
 *   3. turns Deploi Office on for an Office-type connection unless the owner switched it off;
 *   4. runs discovery at once (lib/discovery: the store scan for a store, QuickBooks, CRM and mailbox detectors);
 *   5. sets up the recommended Office team when the organization has no active Office agent, from the discovery
 *      recommendations (the same templates "Set up recommended team" uses), with grants made explicitly by the
 *      autonomy setting (actor autonomy:on-connect, AUTONOMY_POLICY_VERSION in the audit entry): a tool whose action
 *      types the owner left at "do it and tell me" (lib/autonomy modeFor) is granted to act without asking for a
 *      year; a tool with any action type set to ask first is granted "after my approval". An agent the owner deleted
 *      or revoked is never created again;
 *   6. routes the first check: an org-scoped sweep (source 'sweep', externalId connect:<connection id>, deduped by the
 *      router), so every agent looks at once instead of at the next 15-minute sweep;
 *   7. queues the owner's ONE "Here's what I found" update (`autonomy.connect_summary`, once per connection): found,
 *      fixed, queued by the first-day pacing (lib/autonomy/pacing.ts), and what needs the owner, with a link that
 *      pauses everything (the Stop all agents control, lib/engine/kill-switch.ts).
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { orgStopReason } from '../engine/kill-switch'
import { enqueue, registerJobHandler } from '../jobs/queue'
import { log } from '../log'
import { env } from '../env'
import { inferBusinessType } from '../packs/settings'
import type { BusinessType } from '../packs/registry'
import { enableProduct } from '../products'
import { modeFor, type ActionMode } from './index'
import { heldCount } from './pacing'

export type ConnectKind = 'shopify' | 'woocommerce' | 'office' | 'email' | 'buildium'
export type Connected = { orgId: string | null | undefined; kind: ConnectKind; connectionId: string; provider?: string | null; at?: Date }
export type OnConnectResult = { status: 'queued' | 'duplicate' | 'refused' | 'skipped'; reason?: string; businessType?: BusinessType; inferred?: boolean; jobId?: string | null }

export const ON_CONNECT_ACTOR = 'autonomy:on-connect'
/** the rules the autonomy setting follows when it sets a team up (recorded with every grant it makes) */
export const AUTONOMY_POLICY_VERSION = 'autonomy-on-connect/2026-11-07.1'
export const ON_CONNECT_JOB = 'autonomy.connect'
export const SUMMARY_JOB = 'autonomy.connect_summary'
/** an act-without-asking grant made at connect lasts this long (the policy's limit is one year) */
const GRANT_MS = 364 * 864e5
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS: readonly ConnectKind[] = ['shopify', 'woocommerce', 'office', 'email', 'buildium']

export const businessTypeFor = (kind: ConnectKind): BusinessType => (kind === 'shopify' || kind === 'woocommerce' ? 'store' : kind === 'buildium' ? 'property_manager' : 'office')

/** The connection became active. Never throws; safe to call on every callback (deduped by connection id). */
export async function onConnected(input: Connected): Promise<OnConnectResult> {
  const { orgId, kind, connectionId } = input
  if (!orgId || !UUID.test(orgId) || !UUID.test(connectionId) || !KINDS.includes(kind)) return { status: 'skipped', reason: 'not a connection Deploi can act on' }
  try {
    return await admin(async db => {
      const org = await db.one<{ org_type: string; deleted_at: string | null }>('select org_type, deleted_at from agencies where id = $1', [orgId])
      if (!org || org.org_type !== 'merchant' || org.deleted_at) return { status: 'skipped' as const, reason: 'not an active business' }
      const at = input.at ?? new Date()
      const packs = await inferBusinessType(db, orgId, businessTypeFor(kind), kind, ON_CONNECT_ACTOR)
      const row = await db.one<{ id: string }>(`insert into autonomy_connects (org_id, kind, provider, connection_id, connected_at) values ($1,$2,$3,$4,$5)
        on conflict (org_id, connection_id) do nothing returning id`, [orgId, kind, input.provider?.slice(0, 40) ?? null, connectionId, at.toISOString()])
      const base = { businessType: packs.businessType, inferred: packs.source === 'inferred' }
      if (!row) return { status: 'duplicate' as const, ...base }
      if (packs.changed) await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'autonomy.packs_inferred', actor: ON_CONNECT_ACTOR, detail: { business_type: packs.businessType, packs: packs.packs, from: kind, policy_version: AUTONOMY_POLICY_VERSION } })
      const q = await enqueue({ kind: ON_CONNECT_JOB, orgId, payload: { orgId, connectionId }, idempotencyKey: `connect:${connectionId}` }, db)
      if (q.status === 'refused') {
        await db.query(`update autonomy_connects set status = 'failed', result = $2 where id = $1`, [row.id, JSON.stringify({ refused: q.reason })])
        return { status: 'refused' as const, reason: q.reason, ...base }
      }
      return { status: 'queued' as const, jobId: q.id, ...base }
    })
  } catch (e) {
    log.warn('autonomy.on_connect_failed', { org_id: orgId, kind, error: (e as Error).message.slice(0, 200) })
    return { status: 'skipped', reason: 'could not be queued' }
  }
}

// ---------------------------------------------------------------- the first run

type ConnectRow = { id: string; org_id: string; kind: ConnectKind; provider: string | null; connection_id: string; connected_at: string; status: string; event_id: string | null; result: Record<string, unknown>; summary_sent_at: string | null }

export type TeamItem = { template: string; name: string; status: 'created' | 'existing' | 'blocked' | 'owner_removed' | 'skipped' | 'failed' | 'in_progress'; agentId?: string; tiers?: Record<string, string>; needs?: string[]; message?: string }

/** Which owner settings decide each Office tool's grant. */
function toolActions(kind: string): Record<'email' | 'calendar' | 'crm', string[]> {
  return { email: kind === 'accounts_receivable' ? ['send_customer_email', 'send_reminder'] : ['send_customer_email'], calendar: ['book_appointment'], crm: ['update_crm'] }
}

/**
 * The recommended Office team, created and granted by the autonomy setting. Runs only when the organization has no
 * active Office agent. Idempotent: an existing agent of a template is linked, never duplicated (discovery_agents).
 */
export async function setUpTeamOnConnect(orgId: string, recommendations: { template: string; name: string }[], now = new Date()): Promise<{ items: TeamItem[]; skipped?: string }> {
  const { templateSetup, orgSetupContext } = await import('../discovery/team')
  const { createOfficeAgentFor, grantOfficePolicyAsAutonomy } = await import('../office/agents')
  const active = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from office_agents where org_id = $1 and status = 'active'`, [orgId]))
  if ((active?.n ?? 0) > 0) return { items: [], skipped: 'the business already has active Office agents' }
  const ctx = await orgSetupContext(orgId, null)
  const items: TeamItem[] = []
  for (const rec of recommendations) {
    const s = templateSetup(rec.template)
    if (!s || s.agentKind !== 'office' || !s.officePolicy || !s.officeKind) continue
    const kind = s.officeKind
    const base = { template: rec.template, name: s.name }
    // the owner removed an agent of this kind before: never set it up again on their behalf
    const removed = await admin(db => db.one(`select 1 from office_agents where org_id = $1 and kind = $2 and status in ('deleted','revoked') limit 1`, [orgId, kind]))
    if (removed) { items.push({ ...base, status: 'owner_removed', message: 'You removed this agent before, so it was not set up again.' }); continue }
    const existing = await admin(db => s.findExisting(db, ctx))
    if (existing) {
      await admin(db => db.query(`insert into discovery_agents (org_id, template, agent_kind, agent_id, created_by) values ($1,$2,'office',$3,$4) on conflict (org_id, template) do nothing`, [orgId, rec.template, existing, ON_CONNECT_ACTOR]))
      items.push({ ...base, status: 'existing', agentId: existing }); continue
    }
    const blockers = s.blockers(ctx)
    if (blockers.length) { items.push({ ...base, status: 'blocked', needs: blockers, message: `Needs ${blockers.join(', ')} first.` }); continue }
    const won = await admin(db => db.one<{ template: string }>(`insert into discovery_agents (org_id, template, agent_kind, created_by) values ($1,$2,'office',$3)
      on conflict (org_id, template) do update set claimed_at = now(), created_by = excluded.created_by
        where discovery_agents.agent_id is null and discovery_agents.claimed_at <= now() - interval '120 seconds' returning template`, [orgId, rec.template, ON_CONNECT_ACTOR]))
    if (!won) { items.push({ ...base, status: 'in_progress' }); continue }
    try {
      const policy = s.officePolicy(ctx) as Record<string, Record<string, unknown> | unknown>
      const modes: Record<string, Record<string, ActionMode>> = {}
      const tiers: Record<string, string> = {}
      for (const [tool, types] of Object.entries(toolActions(kind)) as ['email' | 'calendar' | 'crm', string[]][]) {
        const t = policy[tool] as Record<string, unknown> | undefined
        if (!t) continue
        const m: Record<string, ActionMode> = {}
        for (const at of types) m[at] = await admin(db => modeFor(db, orgId, at))
        modes[tool] = m
        const ask = Object.values(m).includes('ask_first')
        policy[tool] = { ...t, tier: ask ? 'send_approved' : 'send_autonomous', validUntil: ask ? null : new Date(now.getTime() + GRANT_MS).toISOString() }
        tiers[tool] = ask ? 'send_approved' : 'send_autonomous'
      }
      const r = await createOfficeAgentFor(orgId, ON_CONNECT_ACTOR, { kind, name: s.name, policy })
      await admin(db => db.query('update discovery_agents set agent_id = $3 where org_id = $1 and template = $2', [orgId, rec.template, r.agentId]))
      await grantOfficePolicyAsAutonomy(orgId, r.agentId, r.policyId, r.policyHash, ON_CONNECT_ACTOR,
        { by: 'the owner\'s autonomy settings at connect', policy_version: AUTONOMY_POLICY_VERSION, modes }, { now })
      items.push({ ...base, status: 'created', agentId: r.agentId, tiers })
    } catch (e) {
      await admin(db => db.query('delete from discovery_agents where org_id = $1 and template = $2 and agent_id is null', [orgId, rec.template]))
      items.push({ ...base, status: 'failed', message: (e as Error).message.slice(0, 300) })
    }
  }
  await admin(db => audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'autonomy.team_set_up', actor: ON_CONNECT_ACTOR,
    detail: { policy_version: AUTONOMY_POLICY_VERSION, items: items.map(i => ({ template: i.template, status: i.status, agent_id: i.agentId ?? null, tiers: i.tiers ?? null })) } }))
  return { items }
}

/** The `autonomy.connect` job: products, discovery, the team, the first check, the owner's summary. */
export async function runOnConnect(orgId: string, connectionId: string, now = new Date()): Promise<Record<string, unknown>> {
  const row = await admin(db => db.one<ConnectRow>('select * from autonomy_connects where org_id = $1 and connection_id = $2', [orgId, connectionId]))
  if (!row) return { skipped: true, reason: 'no connect recorded' }
  if (row.status === 'done') return { skipped: true, reason: 'already done' }
  const stopped = await admin(db => orgStopReason(db, orgId))
  if (stopped) { await admin(db => db.query(`update autonomy_connects set status = 'failed', result = $2, updated_at = now() where id = $1`, [row.id, JSON.stringify({ refused: stopped })])); return { skipped: true, reason: stopped } }
  await admin(db => db.query(`update autonomy_connects set status = 'running', updated_at = now() where id = $1`, [row.id]))
  const result: Record<string, unknown> = { policyVersion: AUTONOMY_POLICY_VERSION }
  // 3. the product the connection belongs to (never over an owner who switched it off)
  const product = row.kind === 'shopify' || row.kind === 'woocommerce' ? 'commerce' : 'office'
  await admin(async db => {
    const p = await db.one<{ status: string }>('select status from org_products where org_id = $1 and product = $2', [orgId, product])
    if (!p) { await enableProduct(db, orgId, product, ON_CONNECT_ACTOR); result.productEnabled = product } else if (p.status !== 'active') result.productOff = product
  })
  // 4. discovery now (the store scan, QuickBooks, the CRM and the mailbox), its recommendations for the team
  let recs: { template: string; name: string }[] = []
  try {
    const { runDiscovery } = await import('../discovery/run')
    const d = await runDiscovery(orgId, { trigger: 'connection', source: `connect:${row.kind}:${connectionId}`, actor: ON_CONNECT_ACTOR, now })
    result.discovery = { runId: d.run.id, status: d.run.status, findings: d.run.findings_count, started: d.started }
    recs = d.run.recommendations ?? []
    if (!d.started) recs = (await admin(db => db.one<{ recommendations: typeof recs }>(`select recommendations from discovery_runs where org_id = $1 and status in ('completed','partial') order by started_at desc limit 1`, [orgId])))?.recommendations ?? []
  } catch (e) { result.discovery = { error: (e as Error).message.slice(0, 300) } }
  // 5. the Office team at the owner's autonomy settings
  if (!result.productOff || product !== 'office') {
    try { const t = await setUpTeamOnConnect(orgId, recs, now); result.team = t.items; if (t.skipped) result.teamSkipped = t.skipped } catch (e) { result.team = []; result.teamError = (e as Error).message.slice(0, 300) }
  }
  // 6. the first check, now
  const { routeEvent } = await import('../events')
  const ev = await routeEvent({ source: 'sweep', type: 'sweep', orgId, externalId: `connect:${connectionId}`, occurredAt: now.toISOString(), payload: { connect: true, kind: row.kind, connectionId } })
  result.sweep = { status: ev.status, jobs: ev.jobs.length }
  // 7. the owner's summary, once the first check's jobs ran
  await enqueue({ kind: SUMMARY_JOB, orgId, payload: { orgId, connectionId }, idempotencyKey: `summary:${connectionId}` })
  await admin(db => db.query(`update autonomy_connects set status = 'done', event_id = $2, result = $3, updated_at = now() where id = $1`, [row.id, ev.eventId, JSON.stringify(result)]))
  return result
}

// ---------------------------------------------------------------- what was found

export type FoundSummary = { since: string | null; found: number; fixed: number; inProgress: number; needsYou: number; queued: number; sent: number }

/** What the agents found since `since` (default: the latest connect, else the last 7 days). Counts only. */
export async function foundSummary(db: Db, orgId: string, since?: Date | null): Promise<FoundSummary> {
  const from: Date = since ?? (await db.one<{ connected_at: string }>('select connected_at from autonomy_connects where org_id = $1 order by connected_at desc limit 1', [orgId]).then(r => (r ? new Date(r.connected_at) : new Date(Date.now() - 7 * 864e5))))
  // a minute of slack: discovery and the loops open cases right after the connect is recorded
  const t = new Date(from.getTime() - 60e3).toISOString()
  const c = await db.one<{ found: number; fixed: number; needs: number; closed: number }>(
    `select count(*)::int as found, count(*) filter (where status = 'resolved')::int as fixed,
       count(*) filter (where status in ('awaiting_approval','blocked','failed','escalated'))::int as needs, count(*) filter (where status in ('resolved','cancelled'))::int as closed
     from cases where org_id = $1 and opened_at >= $2`, [orgId, t])
  const sent = await db.one<{ n: number }>(`select count(*)::int as n from autonomy_outbound where org_id = $1 and created_at >= $2`, [orgId, t])
  const found = c?.found ?? 0, fixed = c?.fixed ?? 0, needsYou = c?.needs ?? 0
  return { since: from.toISOString(), found, fixed, needsYou, inProgress: Math.max(0, found - (c?.closed ?? 0) - needsYou), queued: await heldCount(db, orgId, new Date(t)), sent: sent?.n ?? 0 }
}

const KIND_LABEL: Record<ConnectKind, string> = { shopify: 'your Shopify store', woocommerce: 'your WooCommerce store', office: 'your account', email: 'your mailbox', buildium: 'Buildium' }
const PROVIDER_LABEL: Record<string, string> = { quickbooks: 'QuickBooks', hubspot: 'HubSpot', salesforce: 'Salesforce', pipedrive: 'Pipedrive', zoho_crm: 'Zoho CRM', google_calendar: 'Google Calendar', gmail: 'Gmail', microsoft: 'Outlook', deploi: 'your Deploi mailbox', synthetic: 'your mailbox' }
const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`
export const PAUSE_PATH = '/store?pause=all'

/** The `autonomy.connect_summary` job: one owner update per connection, after the first check's jobs ran. */
export async function sendFoundSummary(orgId: string, connectionId: string, attempt = 1): Promise<Record<string, unknown>> {
  const row = await admin(db => db.one<ConnectRow>('select * from autonomy_connects where org_id = $1 and connection_id = $2', [orgId, connectionId]))
  if (!row) return { skipped: true, reason: 'no connect recorded' }
  if (row.summary_sent_at) return { skipped: true, reason: 'already sent' }
  if (row.event_id) {
    // wait for the first check (its original jobs; a paced re-run later is not waited for)
    const pending = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from jobs where org_id = $1 and kind = 'event.handle' and payload->>'eventId' = $2
      and idempotency_key = $2 || ':' || (payload->>'agentKey') and status in ('queued','running')`, [orgId, row.event_id]))
    if ((pending?.n ?? 0) > 0 && attempt < 4) throw new Error('the first check is still running')
  }
  const s = await admin(db => foundSummary(db, orgId, new Date(row.connected_at)))
  const cap = await admin(async db => (await import('./pacing')).firstRunCap(db, orgId))
  const team = (Array.isArray(row.result.team) ? row.result.team : []) as TeamItem[]
  const label = (row.provider && PROVIDER_LABEL[row.provider]) || KIND_LABEL[row.kind]
  const whatIDid = [
    `Found ${n(s.found, 'problem')} and fixed ${s.fixed}, each confirmed with a fresh read.`,
    ...(s.sent ? [`Sent ${n(s.sent, 'customer message')}.`] : []),
    ...(s.queued ? [`${n(s.queued, 'customer message is', 'customer messages are')} queued for the next hours: in the first day I send at most ${cap} an hour, so a backlog does not go out at once.`] : []),
    ...(s.inProgress ? [`${n(s.inProgress, 'problem is', 'problems are')} still being worked on.`] : []),
    s.needsYou ? `${n(s.needsYou, 'thing needs', 'things need')} you: your decision, or something only you can fix.` : 'Nothing needs you right now.',
    ...team.filter(t => t.status === 'created').map(t => `Set up ${t.name} ${t.tiers && Object.values(t.tiers).every(v => v === 'send_autonomous') ? 'to act and tell you after' : 'to ask you first where you said so'}.`),
    ...team.filter(t => t.status === 'blocked').map(t => `${t.name} can start once you add ${(t.needs ?? []).join(', ')}.`),
  ]
  const appUrl = env.appUrl.replace(/\/$/, '')
  const { notifyOwner } = await import('../notify')
  const r = await notifyOwner({
    orgId, agentKey: 'autonomy', agentName: 'Deploi', caseRef: null,
    headline: `Here's what I found in ${label}`,
    whatHappened: `You connected ${label}. I checked everything right away instead of waiting for the next scheduled check.`,
    whatIDid,
    proof: [
      { label: 'Found', value: String(s.found) }, { label: 'Fixed', value: String(s.fixed) }, { label: 'Queued for later hours', value: String(s.queued) }, { label: 'Needs you', value: String(s.needsYou) },
      { label: 'Pause everything', value: 'Stop all agents', url: `${appUrl}${PAUSE_PATH}` },
    ],
    detailsPath: s.needsYou ? '/store/approvals' : '/store',
    severity: s.needsYou || s.queued ? 'action' : 'info',
    dedupeKey: `autonomy:found:${connectionId}`,
  })
  await admin(db => db.query(`update autonomy_connects set summary_sent_at = now(), result = result || $2::jsonb, updated_at = now() where id = $1`, [row.id, JSON.stringify({ summary: { ...s, notify: r.status } })]))
  return { ...s, notify: r.status }
}

registerJobHandler(ON_CONNECT_JOB, async (payload, ctx) => {
  const orgId = String(payload.orgId ?? ''), connectionId = String(payload.connectionId ?? '')
  if (!UUID.test(orgId) || !UUID.test(connectionId)) return { skipped: true, reason: 'invalid connect job' }
  if (ctx.job.org_id && ctx.job.org_id !== orgId) return { skipped: true, reason: 'the payload names another organization' }
  return runOnConnect(orgId, connectionId)
}, { leaseMs: 5 * 60_000, maxAttempts: 3 })

registerJobHandler(SUMMARY_JOB, async (payload, ctx) => {
  const orgId = String(payload.orgId ?? ''), connectionId = String(payload.connectionId ?? '')
  if (!UUID.test(orgId) || !UUID.test(connectionId)) return { skipped: true, reason: 'invalid summary job' }
  if (ctx.job.org_id && ctx.job.org_id !== orgId) return { skipped: true, reason: 'the payload names another organization' }
  return sendFoundSummary(orgId, connectionId, ctx.job.attempts)
}, { leaseMs: 2 * 60_000, maxAttempts: 5, agentWork: false })
