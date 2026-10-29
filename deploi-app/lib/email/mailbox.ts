/**
 * Agent mailboxes: each agent can have its own address on Deploi's domain. The mailbox belongs to that
 * one agent: no other agent may send from it, and mail to it is routed only to that agent's organization.
 * Having a mailbox authorizes nothing: the agent's policy still decides whether it drafts, sends after
 * approval, or sends without asking, and to whom.
 */
import { randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { emailConfig } from './config'
import { DEPLOI_INBOUND, DEPLOI_SEND } from './adapters/deploi'
import type { EmailAccountRow } from './accounts'

/** a-z0-9 words joined by dashes, at most 24 characters; "agent" when nothing usable remains */
export function mailboxLocalPart(agentName: string, code = randomBytes(3).toString('hex')): string {
  const slug = agentName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '') || 'agent'
  return `${slug}.${code}`
}

/** Split "<local>+t-<token>@domain" into the mailbox address and the reply token. */
export function parseAgentAddress(address: string, domain = emailConfig.agentMailDomain): { mailbox: string; token: string | null } | null {
  const a = address.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1')
  const [local, dom] = a.split('@')
  if (!local || !dom || !domain || dom !== domain) return null
  const m = /^([a-z0-9.-]+?)(?:\+t-([a-f0-9]{16,64}))?$/.exec(local)
  return m ? { mailbox: `${m[1]}@${dom}`, token: m[2] ?? null } : null
}

export const replyAddress = (mailbox: string, token: string) => { const [l, d] = mailbox.split('@'); return `${l}+t-${token}@${d}` }

/** Create the agent's mailbox inside the caller's transaction (service role). One live mailbox per agent. */
export async function provisionMailbox(db: Db, input: { id?: string; orgId: string; agentId: string; agentName: string; actor: string }): Promise<EmailAccountRow> {
  const domain = emailConfig.agentMailDomain
  if (!domain) throw new EngineError('not_operational', 'agent mailboxes are not set up in this environment (AGENT_MAIL_DOMAIN)')
  const existing = await db.one<EmailAccountRow>(`select * from email_accounts where agent_id = $1 and provider = 'deploi' and status <> 'disconnected'`, [input.agentId])
  if (existing) return existing
  for (let i = 0; i < 5; i++) {
    const address = `${mailboxLocalPart(input.agentName)}@${domain}`
    const row = await db.one<EmailAccountRow>(`insert into email_accounts (id, org_id, provider, address, display_name, status, granted_scopes, can_send, can_read, is_synthetic, connected_by, agent_id, last_checked_at)
      values (coalesce($1::uuid, gen_random_uuid()), $2, 'deploi', $3, $4, 'active', $5, true, $8, false, $6, $7, now())
      on conflict do nothing returning *`,
      [input.id ?? null, input.orgId, address, `${input.agentName.slice(0, 60)} (Deploi agent)`, [DEPLOI_SEND, DEPLOI_INBOUND], input.actor, input.agentId,
        // replies can only arrive when inbound mail is configured; never claim a mailbox can read when it cannot
        Boolean(emailConfig.agentMailWebhookSecret && emailConfig.agentMailDomain)])
    if (row) {
      await audit(db, { orgId: input.orgId, entityType: 'credential', entityId: row.id, event: 'mailbox.created', actor: input.actor, detail: { agent_id: input.agentId, address } })
      return row
    }
  }
  throw new EngineError('busy', 'could not reserve a mailbox address; try again')
}

/** Merchant action: give an existing agent its own address. */
export async function createAgentMailbox(actor: Actor, agentId: string): Promise<EmailAccountRow> {
  const a = await withActor(actor, db => db.one<{ id: string; org_id: string; name: string; status: string }>('select id, org_id, name, status from agents where id = $1', [agentId]))
  if (!a || a.status === 'deleted') throw new EngineError('not_found', 'agent not found')
  assertMerchant(actor, a.org_id)
  return admin(db => provisionMailbox(db, { orgId: a.org_id, agentId: a.id, agentName: a.name, actor: actor.label }))
}

/** Close an agent's mailbox (delete and revoke): it stops sending, and later mail to it is dropped. */
export async function closeAgentMailbox(db: Db, agentId: string, actor: string) {
  const r = await db.query<{ id: string; org_id: string; address: string }>(`update email_accounts set status = 'disconnected', status_reason = 'the agent was deleted', disconnected_at = now(), can_send = false, can_read = false
    where agent_id = $1 and provider = 'deploi' and status <> 'disconnected' returning id, org_id, address`, [agentId])
  for (const m of r) await audit(db, { orgId: m.org_id, entityType: 'credential', entityId: m.id, event: 'mailbox.closed', actor, detail: { agent_id: agentId, address: m.address } })
  return r.length
}
