/**
 * Inbound loop protection. Mail produced by a machine (out-of-office and vacation replies, bounces,
 * mailing lists, another Deploi agent mailbox) is flagged as an auto-reply: it is stored for the
 * merchant to read, but it never counts as a reply to the agent's message and nothing an agent does
 * may answer it (mayTriggerAgentReply). Detection follows RFC 3834 (Auto-Submitted) plus the common
 * vendor headers and sender addresses.
 */
import type { ReceivedEmail } from './adapters/deploi'

const AUTO_SENDERS = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|auto-?reply|autoresponder)([+.-].*)?@/i
const AUTO_SUBJECT = /^(auto(matic)? ?(reply|response)|out of (the )?office|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|abwesenheit|absence)/i

export function autoReplyReason(mail: Pick<ReceivedEmail, 'subject' | 'headers'>, from: string, agentDomain: string): string | null {
  const h = mail.headers ?? {}
  const auto = (h['auto-submitted'] ?? '').trim().toLowerCase()
  if (auto && auto !== 'no') return `Auto-Submitted: ${auto.slice(0, 40)}`
  const prec = (h['precedence'] ?? '').trim().toLowerCase()
  if (['bulk', 'junk', 'list', 'auto_reply', 'auto-reply'].includes(prec)) return `Precedence: ${prec}`
  if (h['x-autoreply'] !== undefined || h['x-autorespond'] !== undefined) return 'auto-responder header'
  if ((h['x-auto-response-suppress'] ?? '').trim()) return 'X-Auto-Response-Suppress'
  if ((h['list-id'] ?? '').trim()) return 'mailing list (List-Id)'
  if ((h['return-path'] ?? '').trim() === '<>') return 'empty Return-Path (delivery report)'
  const f = from.trim().toLowerCase()
  if (AUTO_SENDERS.test(f)) return 'sent by an automatic address'
  if (agentDomain && f.endsWith(`@${agentDomain}`)) return 'sent by a Deploi agent mailbox'
  if (AUTO_SUBJECT.test((mail.subject ?? '').trim().replace(/^(re|aw|fw|fwd):\s*/i, ''))) return 'automatic reply (subject)'
  return null
}

/** Whether an agent may ever act on (answer, follow up because of, count as a reply) this inbound mail. */
export function mayTriggerAgentReply(i: { status: string; auto_reply: boolean }): boolean {
  return i.status === 'accepted' && !i.auto_reply
}
