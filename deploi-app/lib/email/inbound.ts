/**
 * Inbound mail for agent mailboxes (Resend email.received webhook). Every delivery is:
 *  - recorded once (webhook delivery id, then provider email id and Message-ID per mailbox);
 *  - routed only to the organization that owns the mailbox address;
 *  - threaded to the agent's own message by the tagged Reply-To token, else by In-Reply-To/References;
 *  - classified: reply, merchant_forward, merchant_cc or other;
 *  - accepted from allowed senders (the agent's recipient rules, a member of the organization, an address the
 *    organization wrote to); on the office mailbox also from a first-contact sender that passes the policy in
 *    lib/email/sender-policy.ts (its reply then waits for an owner); anything else is quarantined with a reason
 *    the merchant sees, and can release;
 *  - stored encrypted and audited.
 * Inbound mail is data. It never sends anything, never changes a permission and never starts a run.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { encryptSecret } from '../connectors/credentials'
import { parsePolicy, recipientAllowed } from '../agents/policy'
import { emailConfig } from './config'
import { attachmentMeta, fetchReceivedEmail, type ReceivedEmail } from './adapters/deploi'
import { parseAgentAddress } from './mailbox'
import type { EmailAccountRow } from './accounts'
import { autoReplyReason } from './loop'
import { suppressAddresses } from './suppression'
import { decideSender } from './sender-policy'

export type InboundEvent = { deliveryId: string; type: string; data: Record<string, unknown> }
export type InboundOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'stored'; items: { inboundId: string; agentId: string | null; classification: string; status: 'accepted' | 'quarantined'; threadMessageId: string | null; autoReply: boolean }[] }

const bare = (a: string) => a.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1')
const list = (v: unknown) => (Array.isArray(v) ? v.map(x => bare(String(x))) : typeof v === 'string' && v ? [bare(v)] : [])
const MAX_TEXT = 100_000

export async function processInbound(evt: InboundEvent, fetchEmail: (id: string) => Promise<ReceivedEmail> = fetchReceivedEmail): Promise<InboundOutcome> {
  // one delivery is handled once, whatever the provider retries
  const first = await admin(db => db.one<{ delivery_id: string }>(`insert into inbound_webhook_events (provider, delivery_id, event_type, outcome) values ('resend', $1, $2, 'received')
    on conflict do nothing returning delivery_id`, [evt.deliveryId, evt.type]))
  if (!first) return { outcome: 'duplicate' }
  try { return await handle(evt, fetchEmail) } catch (e) {
    // not handled: release the delivery so the provider's retry is processed (stored rows are deduped by email id)
    await admin(db => db.query(`delete from inbound_webhook_events where provider = 'resend' and delivery_id = $1`, [evt.deliveryId]))
    throw e
  }
}

async function handle(evt: InboundEvent, fetchEmail: (id: string) => Promise<ReceivedEmail>): Promise<InboundOutcome> {
  const done = (o: InboundOutcome) => admin(async db => { await db.query(`update inbound_webhook_events set outcome = $2 where provider = 'resend' and delivery_id = $1`, [evt.deliveryId, o.outcome]); return o })

  // delivery outcomes for mail an agent sent: a bounce or complaint is recorded on that message; "delivered"
  // is noted as evidence but the status stays "Accepted by provider" (the receiving server took it, nothing more)
  if (/^email\.(bounced|complained|delivered)$/.test(evt.type)) {
    const providerId = String(evt.data.email_id ?? '')
    if (!providerId) return done({ outcome: 'ignored', reason: 'no email_id' })
    const m = await admin(db => db.one<{ id: string; org_id: string; agent_id: string | null; status: string; to_addresses: string[]; cc_addresses: string[] }>(`select id, org_id, agent_id, status, to_addresses, cc_addresses from email_messages where provider_message_id = $1`, [providerId]))
    if (!m) return done({ outcome: 'ignored', reason: 'not a message Deploi sent' })
    const bounce = evt.data.bounce as { message?: string; type?: string } | undefined
    await admin(async db => {
      if (evt.type === 'email.delivered') {
        await db.query(`update email_messages set meta = meta || jsonb_build_object('delivery_event', 'delivered', 'delivery_event_at', now()) where id = $1`, [m.id])
      } else {
        const reason = evt.type === 'email.complained' ? 'the recipient marked it as spam' : `bounced: ${String(bounce?.message ?? bounce?.type ?? 'the receiving server refused it').slice(0, 200)}`
        await db.query(`update email_messages set status = 'failed', failure_code = $2, status_reason = $3, meta = meta || jsonb_build_object('delivery_event', $2::text, 'delivery_event_at', now()) where id = $1 and status in ('accepted','delivery_unknown')`,
          [m.id, evt.type === 'email.complained' ? 'complained' : 'bounced', reason])
        // the address is suppressed for this organization: nothing is sent to it again. Only recipients of this
        // message can be suppressed this way (the event's own list narrows it to the ones that bounced)
        const mine = [...m.to_addresses, ...m.cc_addresses].map(a => a.toLowerCase())
        const reported = list(evt.data.to).filter(a => mine.includes(a))
        await suppressAddresses(db, { orgId: m.org_id, addresses: reported.length ? reported : mine, reason: evt.type === 'email.complained' ? 'complained' : 'bounced', sourceMessageId: m.id, detail: reason, actor: 'resend:webhook' })
      }
      await audit(db, { orgId: m.org_id, entityType: 'execution', entityId: m.id, event: evt.type === 'email.delivered' ? 'email.delivery_reported' : 'email.bounced', actor: 'resend:webhook', detail: { email_message: true, agent_id: m.agent_id, event: evt.type } })
    })
    return done({ outcome: 'ignored', reason: `recorded ${evt.type}` })
  }
  if (evt.type !== 'email.received') return done({ outcome: 'ignored', reason: `event ${evt.type}` })
  const emailId = String(evt.data.email_id ?? '')
  if (!emailId) return done({ outcome: 'ignored', reason: 'no email_id' })
  const rcpts = [...new Set([...list(evt.data.to), ...list(evt.data.cc), ...list(evt.data.received_for)])]
  const ours = rcpts.map(r => ({ r, p: parseAgentAddress(r) })).filter((x): x is { r: string; p: { mailbox: string; token: string | null } } => Boolean(x.p))
  if (!ours.length) return done({ outcome: 'ignored', reason: 'not addressed to an agent mailbox' })

  const accounts = await admin(db => db.query<EmailAccountRow & { agent_id: string | null }>(
    `select * from email_accounts where provider = 'deploi' and status <> 'disconnected' and lower(address) = any($1::text[])`, [[...new Set(ours.map(o => o.p.mailbox))]]))
  if (!accounts.length) return done({ outcome: 'ignored', reason: 'no live mailbox at that address' })

  const fetched = await fetchEmail(emailId)
  // attachments: metadata only, cleaned again here whatever the fetcher returned
  const mail: ReceivedEmail = { ...fetched, attachments: fetched.attachments ? attachmentMeta(fetched.attachments) : undefined }
  const from = bare(mail.from || String(evt.data.from ?? ''))
  const items: Extract<InboundOutcome, { outcome: 'stored' }>['items'] = []
  for (const acc of accounts) {
    const token = ours.find(o => o.p.mailbox === acc.address.toLowerCase() && o.p.token)?.p.token ?? null
    const r = await admin(async db => {
      // threading: token first (we control it), then the Message-IDs the sender quoted
      let thread = token ? await db.one<{ id: string; to_addresses: string[]; cc_addresses: string[] }>(`select id, to_addresses, cc_addresses from email_messages where reply_token = $1 and account_id = $2`, [token, acc.id]) : null
      const quoted = [mail.inReplyTo, ...mail.references].filter((x): x is string => Boolean(x))
      if (!thread && quoted.length) thread = await db.one(`select id, to_addresses, cc_addresses from email_messages where account_id = $1 and internet_message_id = any($2::text[]) order by created_at desc limit 1`, [acc.id, quoted])
      const member = await db.one<{ id: string }>(`select id from profiles where agency_id = $1 and lower(email) = $2`, [acc.org_id, from])
      const toAgent = [...list(mail.to), ...list(evt.data.to)].some(a => parseAgentAddress(a)?.mailbox === acc.address.toLowerCase())
      const classification = thread ? 'reply' : member ? (toAgent ? 'merchant_forward' : 'merchant_cc') : 'other'

      // allowed senders: anyone the agent wrote to in this thread, the agent's recipient rules, or the organization's own people
      const agent = acc.agent_id ? await db.one<{ status: string; active_policy_id: string | null }>('select status, active_policy_id from agents where id = $1', [acc.agent_id]) : null
      const pol = agent?.active_policy_id ? await db.one<{ policy: unknown }>('select policy from agent_policies where id = $1', [agent.active_policy_id]) : null
      const email = pol ? parsePolicy(pol.policy).email : undefined
      const auth = mail.authentication ?? {}
      const allowed = Boolean(member) || Boolean(thread && [...thread.to_addresses, ...thread.cc_addresses].includes(from)) || Boolean(email && recipientAllowed(email, from))
      // loop protection: machine-generated mail is kept for the merchant but is never a reply an agent reacts to
      const autoReply = autoReplyReason(mail, from, emailConfig.agentMailDomain)
      // who may reach the mailbox (lib/email/sender-policy.ts): on the organization's office mailbox (Email Operations) a
      // first-contact sender is accepted when authentication passes and nothing looks automatic, bulk or abusive; a store
      // agent's mailbox keeps its allowed list
      const decision = await decideSender(db, { orgId: acc.org_id, accountId: acc.id, from, receivedAt: mail.receivedAt, known: allowed, firstContactAllowed: Boolean(acc.office_mailbox) && !acc.agent_id,
        auth: mail.authentication, autoReply, headers: mail.headers })
      const status = decision.status, reason = decision.reason

      const row = await db.one<{ id: string }>(`insert into email_inbound (org_id, account_id, agent_id, provider_email_id, internet_message_id, from_address, to_addresses, cc_addresses,
          classification, status, status_reason, thread_message_id, auth_results, key_id, content_ciphertext, attachment_count, received_at, attachments, auto_reply, auto_reply_reason, first_contact, quarantine_code)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending','pending',$14,$15,$16,$17,$18,$19,$20) on conflict do nothing returning id`,
        [acc.org_id, acc.id, acc.agent_id, mail.id, mail.messageId, from, list(mail.to), list(mail.cc), classification, status, reason, thread?.id ?? null,
          JSON.stringify(auth), mail.attachments?.length ?? mail.attachmentCount, mail.receivedAt, JSON.stringify(mail.attachments ?? []), Boolean(autoReply), autoReply, decision.firstContact, decision.code])
      if (!row) return null // same email already stored for this mailbox
      const enc = encryptSecret(JSON.stringify({ subject: mail.subject.slice(0, 500), text: mail.text.slice(0, MAX_TEXT) }), `email-inbound:${row.id}`)
      await db.query('update email_inbound set key_id = $2, content_ciphertext = $3 where id = $1', [row.id, enc.keyId, enc.ciphertext])
      if (thread && status === 'accepted' && !autoReply) await db.query('update email_messages set reply_count = reply_count + 1, reply_seen_at = greatest(coalesce(reply_seen_at, $2), $2) where id = $1', [thread.id, mail.receivedAt])
      await audit(db, { orgId: acc.org_id, entityType: 'execution', entityId: row.id, event: `email.inbound.${status}`, actor: 'system:agent-mail',
        detail: { email_inbound: true, agent_id: acc.agent_id, classification, thread_message_id: thread?.id ?? null, reason, quarantine_code: decision.code, first_contact: decision.firstContact, attachments: mail.attachments?.length ?? mail.attachmentCount, auto_reply: autoReply } })
      return { inboundId: row.id, agentId: acc.agent_id, classification, status, threadMessageId: thread?.id ?? null, autoReply: Boolean(autoReply) }
    })
    if (r) items.push(r)
  }
  return done({ outcome: 'stored', items })
}

/** Whether the inbound webhook can accept deliveries here: fail closed without a signing secret. */
export const inboundConfigured = () => Boolean(emailConfig.agentMailWebhookSecret && emailConfig.agentMailDomain)
