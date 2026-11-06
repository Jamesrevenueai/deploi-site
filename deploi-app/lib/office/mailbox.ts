/**
 * The organization's office mailbox: an agent mailbox on Deploi's domain (AGENT_MAIL_DOMAIN) that belongs
 * to no store agent, so office agents can send from it and replies come back through the inbound webhook.
 * A connected account (Gmail, Microsoft, or a synthetic one for tests) can be used instead. Having a
 * mailbox authorizes nothing: each office agent's policy decides what it may send.
 */
import { admin } from '../db'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { emailConfig } from '../email/config'
import { mailboxLocalPart } from '../email/mailbox'
import { DEPLOI_INBOUND, DEPLOI_SEND } from '../email/adapters/deploi'
import { completeConnect, startConnect, type EmailAccountRow } from '../email/accounts'
import { syntheticCode, SYNTH_READ, SYNTH_SEND } from '../email/adapters/synthetic'
import { officeAudit } from './audit'
import { officeConfig } from './config'

export async function createOfficeMailbox(actor: Actor) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot create a mailbox for a customer')
  assertMerchant(actor, actor.orgId)
  const domain = emailConfig.agentMailDomain
  if (!domain) throw new EngineError('not_operational', 'Deploi mailboxes are not set up in this environment (AGENT_MAIL_DOMAIN)')
  return admin(async db => {
    const existing = await db.one<EmailAccountRow>(`select * from email_accounts where org_id = $1 and provider = 'deploi' and office_mailbox and status <> 'disconnected'`, [actor.orgId])
    if (existing) return existing
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [actor.orgId])
    for (let i = 0; i < 5; i++) {
      const address = `${mailboxLocalPart(`${org?.name ?? 'office'}`)}@${domain}`
      const row = await db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, display_name, status, granted_scopes, can_send, can_read, is_synthetic, connected_by, agent_id, office_mailbox, last_checked_at)
        values ($1, 'deploi', $2, $3, 'active', $4, true, true, false, $5, null, true, now()) on conflict do nothing returning *`,
        [actor.orgId, address, `${(org?.name ?? 'Office').slice(0, 60)} (Deploi Office)`, [DEPLOI_SEND, DEPLOI_INBOUND], actor.label])
      if (row) { await officeAudit(db, { orgId: actor.orgId, entityType: 'office_connection', entityId: row.id, event: 'mailbox.created', actor: actor.label, detail: { address } }); return row }
    }
    throw new EngineError('busy', 'could not reserve a mailbox address; try again')
  })
}

/** Tests and demos: a synthetic mailbox (nothing leaves Deploi) connected through the same consent code as a real provider. */
export async function connectSyntheticMailbox(actor: Actor, address?: string) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot connect a mailbox for a customer')
  if (!officeConfig.syntheticAllowed) throw new EngineError('forbidden', 'synthetic mailboxes are not available on this deployment')
  const { url } = await startConnect(actor, { provider: 'synthetic', read: true })
  const state = new URL(url, 'http://x').searchParams.get('state')!
  return (await completeConnect(actor, { state, code: syntheticCode(address ?? `office.${actor.orgId.slice(0, 8)}@synthetic-office.example`, [SYNTH_SEND, SYNTH_READ]), error: null })).account
}

/** What the owner reads before the provider's consent screen asks for inbox access (shown first in the UI). */
export const INBOX_READ_EXPLANATION = [
  'Deploi reads new mail in this inbox so Email Operations can find messages nobody has answered: sender, recipients, subject, text and the names and sizes of attachments.',
  'Attachments are never opened, downloaded or stored. Message text is stored encrypted and shown only to your organization.',
  'Nothing in a message can change what the agent may do or who it writes to. Replies still follow the permission you granted, and the first reply to a new sender always waits for you.',
  'Google calls this permission "View your email messages and settings" (gmail.readonly); Microsoft calls it "Read your mail" (Mail.Read). In many Microsoft 365 organizations an administrator must approve it.',
  'You can turn it off at any time by disconnecting the account; Deploi then deletes its tokens.',
]

/**
 * Start the consent for reading the inbox of an Email Operations agent's Gmail / Outlook mailbox. Only for an
 * agent whose granted policy turned "read my inbox" on; owners and admins only (startConnect checks it).
 */
export async function requestInboxReading(actor: Actor, agentId: string) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot connect a mailbox for a customer')
  const { agentCtx } = await import('./actions')
  const ctx = await admin(db => agentCtx(db, agentId))
  if (!ctx || ctx.agent.org_id !== actor.orgId) throw new EngineError('not_found', 'agent not found')
  if (ctx.agent.kind !== 'email_operations' || !ctx.policy?.emailOps) throw new EngineError('invalid_input', 'only an Email Operations agent reads an inbox')
  if (!ctx.policy.emailOps.readInbox) throw new EngineError('invalid_input', 'turn on "Read my inbox" in the agent\'s permission and grant it first')
  const acc = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1 and org_id = $2', [ctx.policy!.mailboxAccountId, actor.orgId]))
  if (!acc || (acc.provider !== 'gmail' && acc.provider !== 'microsoft')) throw new EngineError('invalid_input', 'inbox reading is for a connected Gmail or Outlook mailbox; the Deploi mailbox is read already')
  const { url } = await startConnect(actor, { provider: acc.provider, accountId: acc.id, read: true, inbox: true, returnTo: '/office/agents' })
  return { url, explanation: INBOX_READ_EXPLANATION }
}
