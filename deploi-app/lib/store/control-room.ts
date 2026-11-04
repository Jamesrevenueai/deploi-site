/**
 * Control Room: one organization-scoped read of everything an owner needs at a glance, plus the
 * organization's emergency stop. Every read runs as the signed-in user (RLS limits it to their
 * organization; Deploi staff are refused here). Stopping sets the organization stop switch (lib/agents/lifecycle.ts) and
 * the agent library's switch, so no server policy logic is duplicated.
 */
import { providerConfigured, type OfficeProvider } from '../office/config'
import { withActor, assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { activity } from '../engine/queries'
import { listInbox } from '../agents/inbox'
import { stopAllAgents as orgStopAll } from '../agents/lifecycle'
import { weeklyFacts, weekStartOf } from '../agents/weekly'
import { listAccounts, providers } from '../email/queries'
import { emailConfig } from '../email/config'
import { enabledProducts, type Product } from '../products'
import { setSwitch } from '../library/switches'
import { shopifyConfig } from '../connectors/shopify/config'
import type { Outcome } from '../engine/outcomes'

export type Tier = 'draft' | 'send_approved' | 'send_autonomous'
export type AgentHealth = 'active' | 'paused' | 'needs_attention' | 'draft' | 'revoked'

export type ControlRoomAgent = {
  id: string; name: string; status: string; health: AgentHealth; attention: string[]
  lastRunAt: string | null; lastRunStatus: string | null; nextRunAt: string | null
  storeTier: Tier | null; emailTier: Tier | null; expiresAt: string | null; version: number | null; pendingVersion: number | null
  awaitingApproval: number; needsPerson: number
}
export type ApprovalItem = { id: string; source: 'change' | 'email'; kind: 'approval' | 'draft'; title: string; agentName: string | null; agentId: string | null; createdAt: string }
export type RecentAction = { id: string; target: string | null; field: string; from: unknown; to: unknown; status: string; outcome: Outcome; startedAt: string; verifiedAt: string | null }
export type ControlRoom = {
  org: { id: string; name: string; timezone: string }
  products: Product[]
  generatedAt: string
  agents: ControlRoomAgent[]
  counts: { total: number; active: number; paused: number; needsAttention: number; draft: number; revoked: number }
  library: { switchedOn: number }
  approvals: { count: number; changes: number; emails: number; drafts: number; items: ApprovalItem[]; source: 'inbox' }
  recent: RecentAction[]
  verification: Record<Outcome, number>
  connections: {
    stores: { id: string; platform: string; name: string; status: string; synthetic: boolean; lastScanAt: string | null }[]
    mailboxes: { agentMailboxes: number; domainConfigured: boolean; liveSends: 'off' | 'allowlist' | 'all' }
    email: { id: string; provider: string; address: string; status: string; liveVerified: boolean }[]
  }
  issues: { high: number; medium: number; low: number; needsPerson: number; total: number }
  weekly: { minutes: number; formula: string; label: 'Estimate' }
}

const DAY = 864e5
const rank = (t: string | null): Tier | null => (t === 'draft' ? 'draft' : t === 'review' || t === 'send_approved' ? 'send_approved' : t === 'autonomous' || t === 'send_autonomous' ? 'send_autonomous' : null)

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'the Control Room belongs to a merchant organization')
  return actor.orgId
}

type AgentRow = {
  id: string; name: string; status: string; next_run_at: string | null; last_run_at: string | null; version: number | null
  approval_mode: string | null; correction_count: number; email_permission: string | null; valid_until: string | null; email_valid_until: string | null
  pending_version: number | null; awaiting: number; needs_person: number; last_status: string | null; last_reason: string | null; last_finished: string | null
}

/** Pure: an agent's health and the reasons it needs the owner, from its row (exported for tests). */
export function agentHealth(r: AgentRow, now = new Date()): { health: AgentHealth; attention: string[]; expiresAt: string | null } {
  const attention: string[] = []
  const expiries = [r.valid_until, r.email_valid_until].filter((x): x is string => Boolean(x)).sort()
  const expiresAt = expiries[0] ?? null
  if (r.status === 'draft') attention.push('waiting for your grant')
  else if (r.pending_version) attention.push(`version ${r.pending_version} waits for your grant`)
  if (r.last_status === 'failed' || r.last_status === 'blocked') attention.push(`last run ${r.last_status}${r.last_reason ? `: ${r.last_reason}` : ''}`)
  if (r.needs_person > 0) attention.push(`${r.needs_person} item${r.needs_person === 1 ? '' : 's'} need a person`)
  if (expiresAt) {
    const left = Date.parse(expiresAt) - now.getTime()
    if (left <= 0) attention.push('its standing authorization has ended; changes wait for approval again')
    else if (left < 14 * DAY) attention.push(`its standing authorization ends in ${Math.ceil(left / DAY)} day${Math.ceil(left / DAY) === 1 ? '' : 's'}`)
  }
  const health: AgentHealth = r.status === 'revoked' ? 'revoked' : r.status === 'draft' ? 'draft' : r.status === 'paused' ? 'paused' : attention.length ? 'needs_attention' : 'active'
  return { health, attention, expiresAt }
}

export async function controlRoom(actor: Actor, now = new Date()): Promise<ControlRoom> {
  const orgId = orgOf(actor)
  const base = await withActor(actor, async db => {
    const org = await db.one<{ id: string; name: string; timezone: string }>('select id, name, timezone from agencies where id = current_org_id()')
    if (!org || org.id !== orgId) throw new EngineError('forbidden', 'not your organization')
    const agents = await db.query<AgentRow>(
      `select a.id, a.name, a.status, a.next_run_at, a.last_run_at, ap.version,
         ap.policy->>'approvalMode' as approval_mode, coalesce(jsonb_array_length(ap.policy->'correctionTypes'), 0)::int as correction_count,
         ap.policy->'email'->>'permission' as email_permission,
         case when ap.policy->>'approvalMode' = 'autonomous' then ap.policy->>'validUntil' end as valid_until,
         case when ap.policy->'email'->>'permission' = 'send_autonomous' then ap.policy->'email'->>'validUntil' end as email_valid_until,
         (select max(version) from agent_policies pp where pp.agent_id = a.id and pp.status = 'pending_grant') as pending_version,
         (select count(*)::int from proposals p where p.agent_id = a.id and p.status = 'pending_approval' and coalesce(p.status_reason, '') not like 'draft:%') as awaiting,
         (select count(*)::int from issues i where i.agent_id = a.id and i.kind = 'needs_person' and i.status in ('open','needs_review')) as needs_person,
         lr.status as last_status, lr.status_reason as last_reason, lr.finished_at as last_finished
       from agents a left join agent_policies ap on ap.id = a.active_policy_id
       left join lateral (select status, status_reason, finished_at from agent_runs r where r.agent_id = a.id order by r.started_at desc limit 1) lr on true
       where a.org_id = current_org_id() and a.status <> 'deleted' order by a.created_at`)
    const issues = await db.query<{ severity: string; kind: string; n: number }>(
      `select severity, kind, count(*)::int as n from issues where org_id = current_org_id() and status in ('open','needs_review') group by 1, 2`)
    const stores = await db.query<{ id: string; platform: string; name: string; status: string; is_synthetic: boolean; last_scan_at: string | null }>(
      `select id, platform, coalesce(display_name, external_id) as name, status, is_synthetic, last_scan_at from store_connections where org_id = current_org_id() order by created_at`)
    const mailboxes = await db.one<{ n: number }>(`select count(*)::int as n from email_accounts where org_id = current_org_id() and provider = 'deploi' and status <> 'disconnected'`)
    const switches = await db.one<{ n: number }>(`select count(*)::int as n from library_switches where org_id = current_org_id() and enabled`)
    const products = await enabledProducts(db, orgId)
    const facts = await weeklyFacts(db, orgId, weekStartOf(now))
    return { org, agents, issues, stores, mailboxes: mailboxes?.n ?? 0, switchedOn: switches?.n ?? 0, products, estimate: facts.estimate }
  })
  const [inbox, act, accounts] = await Promise.all([listInbox(actor), activity(actor, { limit: 50 }), listAccounts(actor)])

  const agents: ControlRoomAgent[] = base.agents.map(r => {
    const h = agentHealth(r, now)
    return {
      id: r.id, name: r.name, status: r.status, health: h.health, attention: h.attention,
      lastRunAt: r.last_finished ?? r.last_run_at, lastRunStatus: r.last_status, nextRunAt: r.status === 'active' ? r.next_run_at : null,
      storeTier: r.correction_count > 0 || r.approval_mode ? rank(r.approval_mode) : null, emailTier: rank(r.email_permission), expiresAt: h.expiresAt,
      version: r.version, pendingVersion: r.pending_version, awaitingApproval: r.awaiting, needsPerson: r.needs_person,
    }
  })
  const count = (h: AgentHealth) => agents.filter(a => a.health === h).length
  const changes = inbox.changes.filter(c => c.kind === 'approval')
  const emails = inbox.emails.filter(e => e.status === 'awaiting_approval')
  const drafts = inbox.changes.length - changes.length + inbox.emails.length - emails.length
  const items: ApprovalItem[] = [
    ...changes.map(c => ({ id: c.id, source: 'change' as const, kind: 'approval' as const, title: `${c.target_label ?? 'Record'}: ${c.change.field} ${String(c.change.from)} → ${String(c.change.to)}`, agentName: c.agent_name, agentId: c.agent_id, createdAt: c.created_at })),
    ...emails.map(e => ({ id: e.id, source: 'email' as const, kind: 'approval' as const, title: e.subject ?? `Email to ${e.to_addresses.join(', ')}`, agentName: e.agent_name, agentId: e.agent_id, createdAt: e.created_at })),
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10)
  const verification: Record<Outcome, number> = { pending: 0, verified: 0, failed: 0, blocked: 0, closed: 0 }
  for (const e of act.executions) verification[e.outcome] = (verification[e.outcome] ?? 0) + 1
  const sev = (s: string) => base.issues.filter(i => i.severity === s).reduce((n, i) => n + i.n, 0)
  return {
    org: base.org, products: base.products, generatedAt: now.toISOString(),
    agents,
    counts: { total: agents.length, active: count('active'), paused: count('paused'), needsAttention: count('needs_attention'), draft: count('draft'), revoked: count('revoked') },
    library: { switchedOn: base.switchedOn },
    approvals: { count: changes.length + emails.length, changes: changes.length, emails: emails.length, drafts, items, source: 'inbox' },
    recent: act.executions.slice(0, 10).map(e => ({ id: e.id, target: e.target_label, field: e.change.field, from: e.change.from, to: e.change.to, status: e.status, outcome: e.outcome, startedAt: e.started_at, verifiedAt: e.verified_at })),
    verification,
    connections: {
      stores: base.stores.map(s => ({ id: s.id, platform: s.platform, name: s.name, status: s.status, synthetic: s.is_synthetic, lastScanAt: s.last_scan_at })),
      mailboxes: { agentMailboxes: base.mailboxes, domainConfigured: Boolean(emailConfig.agentMailDomain), liveSends: emailConfig.liveSends },
      email: accounts.map(a => ({ id: a.id, provider: a.provider, address: a.address, status: a.status, liveVerified: false })),
    },
    issues: { high: sev('high'), medium: sev('medium'), low: sev('low'), needsPerson: base.issues.filter(i => i.kind === 'needs_person').reduce((n, i) => n + i.n, 0), total: base.issues.reduce((n, i) => n + i.n, 0) },
    weekly: base.estimate,
  }
}

export type StopAllResult = { paused: number; alreadyStopped: number; librarySwitchedOff: number; failed: { id: string; name: string; message: string }[] }

/**
 * Emergency stop for the whole organization: pause every active agent (which also cancels its queued
 * changes and emails, through the existing pause path) and switch off every library agent. Idempotent.
 */
export async function stopAllAgents(actor: Actor): Promise<StopAllResult> {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const before = await withActor(actor, async db => ({
    stopped: Number((await db.one<{ n: string }>(`select count(*)::text as n from agents where org_id = current_org_id() and status not in ('active','deleted')`))?.n ?? 0),
    switches: await db.query<{ agent_key: string }>(`select agent_key from library_switches where org_id = current_org_id() and enabled`),
  }))
  // the organization switch: pauses every agent, cancels queued jobs, holds sends and refuses resume until cleared
  const org = await orgStopAll(actor, 'stopped from the Control Room')
  const out: StopAllResult = { paused: org.agentsPaused, alreadyStopped: before.stopped, librarySwitchedOff: 0, failed: [] }
  for (const s of before.switches) {
    try { await setSwitch(actor, s.agent_key, false); out.librarySwitchedOff++ } catch (e) { out.failed.push({ id: s.agent_key, name: s.agent_key, message: (e as Error).message }) }
  }
  return out
}

// ------------------------------------------------------------------------------- integrations

export type IntegrationStatus = 'connected' | 'needs_setup' | 'not_available'
export type Integration = {
  key: 'shopify' | 'woocommerce' | 'agent_mailbox' | 'gmail' | 'microsoft' | 'hubspot' | 'google_calendar' | 'stripe'
  name: string; group: 'commerce' | 'email' | 'office' | 'billing'
  status: IntegrationStatus; detail: string
  usedFor: string; permissions: string[]
  /** where to connect or manage it; `probe` pages may not exist yet in this deployment (the client checks) */
  href: string; probe: boolean
  liveVerified: boolean
}

/** Status of every integration, honestly: nothing reads "connected" without a connection row or configured credentials. */
export async function integrations(actor: Actor): Promise<Integration[]> {
  orgOf(actor)
  const { stores, accounts, mailboxes, office } = await withActor(actor, async db => ({
    stores: await db.query<{ platform: string; status: string; name: string; is_synthetic: boolean }>(`select platform, status, coalesce(display_name, external_id) as name, is_synthetic from store_connections where org_id = current_org_id()`),
    accounts: await db.query<{ provider: string; status: string; address: string }>(`select provider, status, address from email_accounts where org_id = current_org_id() and status <> 'disconnected' and provider in ('gmail','microsoft')`),
    mailboxes: (await db.one<{ n: number }>(`select count(*)::int as n from email_accounts where org_id = current_org_id() and provider = 'deploi' and status <> 'disconnected'`))?.n ?? 0,
    office: await db.query<{ provider: string; status: string; name: string; is_synthetic: boolean }>(`select provider, status, coalesce(display_name, external_account_id) as name, is_synthetic from office_connections where org_id = current_org_id() and status <> 'disconnected'`),
  }))
  const officeIntegration = (p: OfficeProvider): Pick<Integration, 'status' | 'detail'> => {
    const c = office.find(x => x.provider === p)
    if (c?.status === 'active') return { status: 'connected', detail: `${c.name}${c.is_synthetic ? ' (synthetic test account)' : ''}. Not live-verified.` }
    if (c?.status === 'needs_reauth') return { status: 'needs_setup', detail: `${c.name}: reconnect in Deploi Office.` }
    return providerConfigured(p) ? { status: 'needs_setup', detail: 'Available, not connected. Connect it in Deploi Office.' } : { status: 'not_available', detail: 'Not configured on this environment yet.' }
  }
  const store = (p: string) => stores.find(s => s.platform === p && s.status === 'active')
  const prov = new Map(providers().map(p => [p.provider, p]))
  const shop = store('shopify'), woo = store('woocommerce')
  const mail = (p: 'gmail' | 'microsoft', name: string): Integration => {
    const a = accounts.filter(x => x.provider === p)
    const configured = Boolean(prov.get(p)?.configured)
    return {
      key: p, name, group: 'email', liveVerified: false, href: '/store/connections', probe: false,
      status: a.length ? 'connected' : configured ? 'needs_setup' : 'not_available',
      detail: a.length ? `${a.length} account${a.length === 1 ? '' : 's'} connected (${a.map(x => x.address).join(', ')}). Not live-verified.` : configured ? 'Available, not connected. Not live-verified.' : 'Not switched on in this environment. Not live-verified.',
      usedFor: 'Agents send approved email from your own address instead of their Deploi mailbox.',
      permissions: ['Send email you approve (one at a time, unless you grant more)', 'Read replies to messages an agent sent, only when a task needs it'],
    }
  }
  return [
    {
      key: 'shopify', name: 'Shopify', group: 'commerce', liveVerified: false, href: '/store/connect', probe: false,
      status: shop ? 'connected' : shopifyConfig.configured ? 'needs_setup' : 'not_available',
      detail: shop ? `${shop.name}${shop.is_synthetic ? ' (synthetic test store)' : ''}` : shopifyConfig.configured ? 'Install the Deploi app from your Shopify admin.' : 'The Shopify app is not configured on this environment.',
      usedFor: 'Deploi Commerce reads products and inventory to find stock and listing problems.',
      permissions: ['Read products, variants, inventory and locations', 'Write products and publications only for an agent you widen past drafts only'],
    },
    {
      key: 'woocommerce', name: 'WooCommerce', group: 'commerce', liveVerified: false, href: '/store/connect/woocommerce', probe: true,
      status: woo ? 'connected' : 'needs_setup',
      detail: woo ? `${woo.name}${woo.is_synthetic ? ' (synthetic test store)' : ''}` : 'Connect a WooCommerce store with its own API keys.',
      usedFor: 'Deploi Commerce for WooCommerce stores: the same checks and the same permission levels.',
      permissions: ['Read products and stock', 'Write only what an agent you widen past drafts only is granted'],
    },
    {
      key: 'agent_mailbox', name: 'Agent mailboxes', group: 'email', liveVerified: false, href: '/store/connections', probe: false,
      status: mailboxes > 0 ? 'connected' : emailConfig.agentMailDomain ? 'needs_setup' : 'not_available',
      detail: mailboxes > 0 ? `${mailboxes} agent address${mailboxes === 1 ? '' : 'es'}. Live sending: ${emailConfig.liveSends === 'all' ? 'on' : emailConfig.liveSends === 'allowlist' ? 'test recipients only' : 'off (messages are held)'}.` : emailConfig.agentMailDomain ? 'An agent gets its own address when it has an email task.' : 'Agent mailboxes are not set up on this environment.',
      usedFor: 'Each agent with email tasks writes from its own address on Deploi\'s domain.',
      permissions: ['Draft email for your review (default)', 'Send only what you approve, or within limits you grant'],
    },
    mail('gmail', 'Gmail / Google Workspace'),
    mail('microsoft', 'Microsoft 365 / Outlook'),
    {
      key: 'hubspot', name: 'HubSpot', group: 'office', liveVerified: false, href: '/office/connections', probe: false, ...officeIntegration('hubspot'),
      usedFor: 'Deploi Office follows up new leads and keeps contact records current.',
      permissions: ['Read contacts and deals', 'Draft follow-ups; writing back needs your grant'],
    },
    {
      key: 'google_calendar', name: 'Google Calendar', group: 'office', liveVerified: false, href: '/office/connections', probe: false, ...officeIntegration('google_calendar'),
      usedFor: 'Deploi Office proposes meeting times from your free and busy slots.',
      permissions: ['Read free and busy times', 'Create events only for bookings you approve or grant'],
    },
    {
      key: 'stripe', name: 'Stripe billing', group: 'billing', liveVerified: false, href: '/store/billing', probe: true,
      status: process.env.STRIPE_SECRET_KEY && (process.env.BILLING_MODE ?? 'off') !== 'off' ? 'needs_setup' : 'not_available',
      detail: process.env.STRIPE_SECRET_KEY && (process.env.BILLING_MODE ?? 'off') !== 'off' ? 'Billing is set up on this environment; manage your plan on the billing page.' : 'Billing is not set up on this environment. Paid pilots are invoiced directly.',
      usedFor: 'Your Deploi subscription. Agents never use it.',
      permissions: ['None for agents', 'You approve every charge'],
    },
  ]
}
