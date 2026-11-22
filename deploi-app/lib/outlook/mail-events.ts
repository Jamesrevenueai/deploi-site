/**
 * New Outlook mail -> agent events. Called once per newly stored inbound message of a Microsoft 365 account
 * (lib/email/inbox-sync.ts, inside the same transaction as the email_inbound row):
 *   'mail.received'  every new message (ids, sender, subject, the stored row; the text stays encrypted in email_inbound)
 *   'lead.email'     the message is a lead notification (Zillow, Apartments.com, Zumper, or a generic lead email),
 *                    parsed by rules (lib/leads/email-parsers.ts). Quarantined mail never becomes a lead.
 * Both dedupe on the provider message id. Gmail is deferred: its mail is stored as before and emits nothing here.
 */
import type { Db } from '../db'
import type { ProviderMessage } from '../email/readers/parse'
import { parseLeadEmail } from '../leads/email-parsers'
import { emitConnectionEvent } from '../connections/events'

export async function emitMailEvents(db: Db, i: { orgId: string; accountId: string; inboundId: string; status: string; message: ProviderMessage }) {
  const m = i.message
  const at = new Date(m.receivedAt).toISOString()
  const base = { orgId: i.orgId, connectionId: i.accountId, occurredAt: at }
  const out = { mail: await emitConnectionEvent(db, { ...base, source: 'outlook', type: 'mail.received', externalId: `mail:${m.providerMessageId}`,
    payload: { accountId: i.accountId, inboundId: i.inboundId, providerMessageId: m.providerMessageId, threadId: m.providerThreadId, from: m.from, subject: m.subject.slice(0, 300), receivedAt: at, status: i.status, attachments: m.attachments.length } }),
    lead: null as null | 'emitted' | 'duplicate' }
  if (i.status === 'quarantined') return out
  const lead = parseLeadEmail({ from: m.from, replyTo: m.headers['reply-to'] ?? null, subject: m.subject, text: m.text, receivedAt: at })
  if (lead) {
    const auth = m.authentication ?? {}
    out.lead = await emitConnectionEvent(db, { ...base, source: 'outlook', type: 'lead.email', externalId: `lead:${m.providerMessageId}`,
      payload: { accountId: i.accountId, inboundId: i.inboundId, providerMessageId: m.providerMessageId, receivedAt: at, lead,
        // a portal lead from a sender that failed DKIM/DMARC is passed on, but marked, so an agent can ask before acting
        senderVerified: auth.dmarc === 'pass' || auth.dkim === 'pass' ? true : Object.keys(auth).length ? false : null } })
  }
  return out
}
