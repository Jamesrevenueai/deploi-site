/** Reads for the /office screens. RLS-visible tables are read as the user; exact content (payloads) through the server after the organization check. */
import { admin } from '../db'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { hasProduct } from '../products'
import { emailConfig } from '../email/config'
import { officeConfig, PROVIDER_LABEL, providerConfigured, type OfficeProvider } from './config'
import { listOfficePendingApprovals } from './approvals'
import { OFFICE_TEMPLATES } from './templates'
import type { ActionPayload } from './actions'

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi Office is shown to the customer only')
  assertMerchant(actor, actor.orgId)
  return actor.orgId
}

export async function officeEnabled(actor: Actor) { const org = orgOf(actor); return admin(db => hasProduct(db, org, 'office')) }

export function describePayload(p: ActionPayload): string {
  switch (p.type) {
    case 'email': return `Email to ${p.to}: "${p.subject}"`
    case 'event': return `Calendar event "${p.summary}" ${p.start} to ${p.end} with ${p.attendees.join(', ')}${p.meet ? ' (Google Meet)' : ''}`
    case 'event_patch': return `Move event to ${p.start}`
    case 'event_delete': return 'Cancel event'
    case 'note': return `HubSpot note on contact ${p.contactId}`
    case 'task': return `HubSpot task "${p.subject}"`
    case 'contact_update': return `HubSpot contact ${p.contactId}: ${Object.entries(p.properties).map(([k, v]) => `${k} → ${v}`).join(', ')}`
    case 'deal_stage': return `HubSpot deal ${p.dealId}: stage → ${p.stage}`
  }
}

export async function officeOverview(actor: Actor) {
  const org = orgOf(actor)
  return withActor(actor, async db => {
    const n = async (sql: string) => Number((await db.one<{ n: string }>(sql, [org]))?.n ?? 0)
    return {
      leadsInFollowup: await n(`select count(*)::text as n from office_leads where org_id = $1 and status = 'active'`),
      leadsReplied: await n(`select count(*)::text as n from office_leads where org_id = $1 and status = 'replied'`),
      meetingsBooked: await n(`select count(*)::text as n from office_meetings where org_id = $1 and status = 'booked'`),
      pendingApprovals: await n(`select count(*)::text as n from office_actions where org_id = $1 and status = 'awaiting_approval'`),
      drafts: await n(`select count(*)::text as n from office_actions where org_id = $1 and status = 'draft'`),
      agents: await n(`select count(*)::text as n from office_agents where org_id = $1 and status in ('active','paused','draft')`),
      recent: await db.query(`select a.id, a.kind, a.purpose, a.status, a.status_reason, a.updated_at, g.name as agent_name from office_actions a join office_agents g on g.id = a.agent_id where a.org_id = $1 order by a.updated_at desc limit 10`, [org]),
    }
  })
}

export async function officeConnections(actor: Actor) {
  const org = orgOf(actor)
  const rows = await withActor(actor, db => db.query<{ id: string; provider: OfficeProvider; status: string; status_reason: string | null; is_synthetic: boolean; display_name: string | null; external_account_id: string; scopes: string[]; timezone: string | null; connected_at: string }>(
    `select id, provider, status, status_reason, is_synthetic, display_name, external_account_id, scopes, timezone, connected_at from office_connections where org_id = $1 and status <> 'disconnected' order by provider`, [org]))
  const mailboxes = await withActor(actor, db => db.query<{ id: string; provider: string; address: string; status: string; can_send: boolean; can_read: boolean; is_synthetic: boolean; office_mailbox: boolean }>(
    `select id, provider, address, status, can_send, can_read, is_synthetic, office_mailbox from email_accounts where org_id = $1 and status <> 'disconnected' and (provider <> 'deploi' or office_mailbox) order by connected_at`, [org]))
  const providers = (['hubspot', 'google_calendar'] as OfficeProvider[]).map(p => ({ provider: p, label: PROVIDER_LABEL[p], configured: providerConfigured(p), connection: rows.find(r => r.provider === p) ?? null }))
  return { providers, mailboxes, syntheticAllowed: officeConfig.syntheticAllowed, officeMailboxAvailable: Boolean(emailConfig.agentMailDomain), liveSends: emailConfig.liveSends }
}

export async function officeAgents(actor: Actor) {
  const org = orgOf(actor)
  const agents = await withActor(actor, db => db.query(`select a.id, a.kind, a.name, a.status, a.next_run_at, a.last_run_at, a.created_at,
      p.version as active_version, p.summary as active_summary, p.policy as active_policy,
      (select row_to_json(x) from (select id, version, policy_hash, summary, expansion, policy from office_agent_policies q where q.agent_id = a.id and q.status = 'pending_grant' order by version desc limit 1) x) as pending
    from office_agents a left join office_agent_policies p on p.id = a.active_policy_id where a.org_id = $1 and a.status <> 'deleted' order by a.created_at`, [org]))
  return { agents, templates: OFFICE_TEMPLATES }
}

export async function officeAgentDetail(actor: Actor, agentId: string) {
  const org = orgOf(actor)
  return withActor(actor, async db => {
    const agent = await db.one(`select * from office_agents where id = $1 and org_id = $2`, [agentId, org])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    return {
      agent,
      policies: await db.query(`select id, version, status, policy_hash, summary, expansion, policy, granted_by, granted_at, created_at from office_agent_policies where agent_id = $1 order by version desc limit 10`, [agentId]),
      runs: await db.query(`select id, trigger, status, status_reason, counts, started_at, finished_at from office_runs where agent_id = $1 order by started_at desc limit 10`, [agentId]),
      leads: await db.query(`select id, email, first_name, company, status, stop_reason, touches, next_touch_at, replied_at from office_leads where agent_id = $1 order by created_at desc limit 50`, [agentId]),
      meetings: await db.query(`select id, contact_email, status, status_reason, proposed_slots, chosen_slot, meet_link, created_at from office_meetings where agent_id = $1 order by created_at desc limit 20`, [agentId]),
    }
  })
}

export async function officeApprovals(actor: Actor) {
  const org = orgOf(actor)
  return admin(async db => {
    const pending = await listOfficePendingApprovals(db, org)
    const drafts = await db.query<{ id: string; kind: string; purpose: string; payload: ActionPayload; payload_hash: string; status_reason: string | null; created_at: string; agent_name: string }>(
      `select a.id, a.kind, a.purpose, a.payload, a.payload_hash, a.status_reason, a.created_at, g.name as agent_name from office_actions a join office_agents g on g.id = a.agent_id where a.org_id = $1 and a.status = 'draft' order by a.created_at desc limit 50`, [org])
    return { pending, drafts }
  })
}

export async function officeWorkLog(actor: Actor) {
  const org = orgOf(actor)
  const actions = await admin(db => db.query<{ id: string; kind: string; purpose: string; status: string; status_reason: string | null; approval_kind: string | null; approved_by: string | null; policy_version: number | null; payload: ActionPayload; external_id: string | null; verified_at: string | null; updated_at: string; agent_name: string }>(
    `select a.id, a.kind, a.purpose, a.status, a.status_reason, a.approval_kind, a.approved_by, a.policy_version, a.payload, a.external_id, a.verified_at, a.updated_at, g.name as agent_name
     from office_actions a join office_agents g on g.id = a.agent_id where a.org_id = $1 order by a.updated_at desc limit 100`, [org]))
  const events = await withActor(actor, db => db.query(`select id, at, event, actor, entity_type, entity_id, detail from engine_audit where org_id = $1 and event like 'office.%' order by at desc limit 100`, [org]))
  return { actions: actions.map(a => ({ ...a, payload: undefined, what: describePayload(a.payload) })), events }
}
