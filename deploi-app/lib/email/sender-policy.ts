/**
 * Who may reach Email Operations. A message from a sender the organization already knows (one of its own
 * people, an address it wrote to, a sender whose first reply the owner approved, or the agent's own
 * recipient rules) is accepted as before, unless the owner blocked the sender or SPF/DKIM/DMARC explicitly
 * failed. A first-contact message (a sender the organization never wrote to) is accepted only when ALL of:
 *  - SPF, DKIM and DMARC all report "pass" (fail closed: a missing, "gray", "unknown" or
 *    "processing_failed" result quarantines it);
 *  - it is not automatic (Auto-Submitted, auto-responder headers) and not bulk or list mail
 *    (Precedence bulk/list/junk, List-Id, List-Unsubscribe, bulk-mailer headers);
 *  - the sender is not suppressed (bounced, complained, unsubscribed);
 *  - the sender has fewer than EMAIL_FIRST_CONTACT_SENDER_DAILY first-contact messages on this mailbox in
 *    the last 24 hours, and the mailbox fewer than EMAIL_FIRST_CONTACT_MAILBOX_DAILY;
 *  - the sender is not on the owner's blocklist.
 * Everything else is quarantined with a reason code the inbox shows; the owner can release a message.
 * An accepted first-contact message is marked first_contact: the reply to it always waits for an owner's
 * (or admin's) individual approval, whatever the agent's tier, and that approval trusts the sender.
 * Message content never takes part in these decisions, and nothing here can change recipients, tiers or tools.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { assertCan } from '../platform/rbac'
import { emailConfig } from './config'

export type AuthResults = Record<string, string | null | undefined> | null | undefined
export type QuarantineCode = 'blocked' | 'auth_failed' | 'auth_unverified' | 'automated' | 'bulk' | 'suppressed' | 'rate_sender' | 'rate_mailbox' | 'not_allowed'
export type SenderDecision = { status: 'accepted' | 'quarantined'; code: QuarantineCode | null; reason: string | null; firstContact: boolean }

export const QUARANTINE_TEXT: Record<QuarantineCode, string> = {
  blocked: 'you blocked this sender',
  auth_failed: 'failed sender authentication',
  auth_unverified: 'a new sender whose SPF, DKIM and DMARC did not all pass',
  automated: 'automatic mail from a new sender',
  bulk: 'bulk or mailing-list mail from a new sender',
  suppressed: 'this address bounced, complained or unsubscribed earlier',
  rate_sender: 'too many first messages from this new sender today',
  rate_mailbox: 'too many messages from new senders on this mailbox today',
  not_allowed: "the sender is not on this agent's allowed list",
}

const AUTH_KEYS = ['spf', 'dkim', 'dmarc'] as const
/** Results that explicitly failed (any sender is quarantined for these). */
export const authFailures = (auth: AuthResults) => AUTH_KEYS.filter(k => String(auth?.[k] ?? '').toLowerCase() === 'fail')
/** First contact needs all three to pass; anything else (missing included) fails closed. */
export const authAllPass = (auth: AuthResults) => Boolean(auth) && AUTH_KEYS.every(k => String(auth?.[k] ?? '').toLowerCase() === 'pass')

/** Bulk or list mail (headers are lower-case names). */
export function bulkReason(h: Record<string, string> | undefined): string | null {
  if (!h) return null
  const prec = (h['precedence'] ?? '').trim().toLowerCase()
  if (['bulk', 'list', 'junk'].includes(prec)) return `Precedence: ${prec}`
  if ((h['list-id'] ?? '').trim()) return 'List-Id'
  if ((h['list-unsubscribe'] ?? '').trim()) return 'List-Unsubscribe'
  if ((h['x-mailer'] ?? '').match(/mailchimp|sendgrid|campaign|mass ?mail/i)) return 'bulk mailer'
  return null
}

const domainOf = (a: string) => (a.includes('@') ? '@' + a.split('@').pop()! : '')

/** Pattern: an address or @domain, lower case and validated (the same rule as the database check). */
export function normalizePattern(v: string): string {
  const p = String(v ?? '').trim().toLowerCase()
  if (!/^([^@\s]+@|@)[a-z0-9.-]+\.[a-z0-9-]+$/.test(p) || p.length > 254) throw new EngineError('invalid_input', 'enter an email address or @domain')
  return p
}

export async function senderRule(db: Db, orgId: string, kind: 'block' | 'trusted', address: string): Promise<boolean> {
  const a = address.toLowerCase()
  return Boolean(await db.one('select 1 from email_sender_rules where org_id = $1 and kind = $2 and pattern = any($3::text[])', [orgId, kind, kind === 'block' ? [a, domainOf(a)] : [a]]))
}

/** The organization already knows this sender: one of its people, an address it wrote to, or a sender the owner trusted. */
export async function knownSender(db: Db, orgId: string, address: string): Promise<boolean> {
  const a = address.toLowerCase()
  if (await db.one(`select 1 from profiles where agency_id = $1 and lower(email) = $2`, [orgId, a])) return true
  if (await db.one(`select 1 from email_messages where org_id = $1 and status in ('accepted', 'delivery_unknown') and $2 = any(to_addresses || cc_addresses) limit 1`, [orgId, a])) return true
  return senderRule(db, orgId, 'trusted', a)
}

export type SenderInput = {
  orgId: string; accountId: string; from: string; receivedAt: string
  /** known by the caller's own rules (thread recipients, agent recipient rules); knownSender() is checked too */
  known: boolean
  /** whether first-contact acceptance applies to this mailbox (the office mailbox, connected inboxes); else unknown senders are quarantined */
  firstContactAllowed: boolean
  auth: AuthResults
  autoReply: string | null
  headers?: Record<string, string>
}

export async function decideSender(db: Db, i: SenderInput): Promise<SenderDecision> {
  const q = (code: QuarantineCode, detail?: string): SenderDecision => ({ status: 'quarantined', code, reason: detail ? `${QUARANTINE_TEXT[code]} (${detail})` : QUARANTINE_TEXT[code], firstContact: false })
  const from = i.from.toLowerCase()
  if (await senderRule(db, i.orgId, 'block', from)) return q('blocked')
  const failed = authFailures(i.auth)
  if (failed.length) return q('auth_failed', failed.join(', '))
  if (i.known || await knownSender(db, i.orgId, from)) return { status: 'accepted', code: null, reason: null, firstContact: false }
  if (!i.firstContactAllowed) return q('not_allowed')
  // first contact: every condition must hold
  if (!authAllPass(i.auth)) {
    const got = AUTH_KEYS.map(k => `${k}=${String(i.auth?.[k] ?? 'missing').toLowerCase().slice(0, 20)}`).join(', ')
    return q('auth_unverified', got)
  }
  if (i.autoReply) return q('automated', i.autoReply)
  const bulk = bulkReason(i.headers)
  if (bulk) return q('bulk', bulk)
  if (await db.one('select 1 from email_suppressions where org_id = $1 and address = $2', [i.orgId, from])) return q('suppressed')
  const since = new Date(new Date(i.receivedAt).getTime() - 864e5).toISOString()
  const per = await db.one<{ n: string }>(`select count(*)::text as n from email_inbound where account_id = $1 and lower(from_address) = $2 and first_contact and received_at > $3`, [i.accountId, from, since])
  if (Number(per?.n ?? 0) >= emailConfig.firstContactSenderDaily) return q('rate_sender', `${emailConfig.firstContactSenderDaily} a day`)
  const box = await db.one<{ n: string }>(`select count(*)::text as n from email_inbound where account_id = $1 and first_contact and received_at > $2`, [i.accountId, since])
  if (Number(box?.n ?? 0) >= emailConfig.firstContactMailboxDaily) return q('rate_mailbox', `${emailConfig.firstContactMailboxDaily} a day`)
  return { status: 'accepted', code: null, reason: 'first message from a new sender: the reply waits for your approval', firstContact: true }
}

/** Whether a reply to this inbound message must wait for an owner's individual approval (first contact, sender not yet trusted). */
export async function needsFirstReplyApproval(db: Db, orgId: string, inboundId: string): Promise<boolean> {
  const i = await db.one<{ first_contact: boolean; from_address: string }>('select first_contact, from_address from email_inbound where id = $1 and org_id = $2', [inboundId, orgId])
  if (!i?.first_contact) return false
  return !(await senderRule(db, orgId, 'trusted', i.from_address))
}

/** The owner approved the first reply to this sender: later replies follow the agent's tier. */
export async function trustSender(db: Db, s: { orgId: string; address: string; actor: string; sourceRef?: string | null }) {
  const p = normalizePattern(s.address)
  const r = await db.one<{ id: string }>(`insert into email_sender_rules (org_id, kind, pattern, reason, source_ref, created_by) values ($1,'trusted',$2,'you approved the first reply to this sender',$3,$4)
    on conflict (org_id, kind, pattern) do nothing returning id`, [s.orgId, p, s.sourceRef ?? null, s.actor.slice(0, 160)])
  if (r) await audit(db, { orgId: s.orgId, entityType: 'email', entityId: r.id, event: 'email.sender_trusted', actor: s.actor, detail: { source_ref: s.sourceRef ?? null } })
}

// ---------------------------------------------------------------- owner actions

async function ownerOnly(actor: Actor, orgId: string) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot change who may write to a customer')
  assertMerchant(actor, orgId)
  await assertCan(actor, orgId, 'agent.grant')
}

/**
 * Release a quarantined message: it becomes visible to Email Operations. A sender that is still unknown
 * stays first contact, so the reply still waits for an individual approval. Blocked and suppressed senders
 * cannot be released (unblock first; suppression protects the recipient).
 */
export async function releaseInbound(actor: Actor, inboundId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(inboundId)) throw new EngineError('invalid_input', 'unknown message')
  const row = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from email_inbound where id = $1', [inboundId]))
  if (!row) throw new EngineError('not_found', 'message not found')
  await ownerOnly(actor, row.org_id)
  return admin(async db => {
    const i = (await db.one<{ id: string; org_id: string; status: string; quarantine_code: string | null; from_address: string; status_reason: string | null }>('select * from email_inbound where id = $1 for update', [inboundId]))!
    if (i.status !== 'quarantined') throw new EngineError('not_pending', 'this message is not quarantined')
    if (await senderRule(db, i.org_id, 'block', i.from_address)) throw new EngineError('forbidden', 'you blocked this sender; unblock it first')
    if (await db.one('select 1 from email_suppressions where org_id = $1 and address = $2', [i.org_id, i.from_address.toLowerCase()])) throw new EngineError('forbidden', 'this address bounced, complained or unsubscribed; Deploi does not answer it')
    const known = await knownSender(db, i.org_id, i.from_address)
    await db.query(`update email_inbound set status = 'accepted', released_by = $2, released_at = now(), first_contact = $3,
      status_reason = $4 where id = $1`, [i.id, actor.label.slice(0, 160), !known, `released by ${actor.label.slice(0, 120)} (was: ${(i.status_reason ?? i.quarantine_code ?? 'quarantined').slice(0, 200)})`])
    await audit(db, { orgId: i.org_id, entityType: 'email', entityId: i.id, event: 'email.inbound.released', actor: actor.label, detail: { email_inbound: true, quarantine_code: i.quarantine_code, first_contact: !known } })
    return { inboundId: i.id, status: 'accepted' as const, firstContact: !known }
  })
}

export async function blockSender(actor: Actor, pattern: string, reason?: string | null) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot change who may write to a customer')
  await ownerOnly(actor, actor.orgId)
  const p = normalizePattern(pattern)
  return admin(async db => {
    await db.query(`insert into email_sender_rules (org_id, kind, pattern, reason, created_by) values ($1,'block',$2,$3,$4) on conflict (org_id, kind, pattern) do nothing`, [actor.orgId, p, reason?.slice(0, 300) ?? null, actor.label.slice(0, 160)])
    await db.query(`delete from email_sender_rules where org_id = $1 and kind = 'trusted' and (pattern = $2 or ($2 like '@%' and pattern like '%' || $2))`, [actor.orgId, p])
    await audit(db, { orgId: actor.orgId, entityType: 'email', entityId: null, event: 'email.sender_blocked', actor: actor.label, detail: { domain: p.startsWith('@') } })
    return { pattern: p, blocked: true }
  })
}

export async function unblockSender(actor: Actor, pattern: string) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot change who may write to a customer')
  await ownerOnly(actor, actor.orgId)
  const p = normalizePattern(pattern)
  return admin(async db => {
    await db.query(`delete from email_sender_rules where org_id = $1 and kind = 'block' and pattern = $2`, [actor.orgId, p])
    await audit(db, { orgId: actor.orgId, entityType: 'email', entityId: null, event: 'email.sender_unblocked', actor: actor.label, detail: {} })
    return { pattern: p, blocked: false }
  })
}

export async function listSenderRules(actor: Actor) {
  return withActor(actor, db => db.query<{ id: string; kind: string; pattern: string; reason: string | null; created_by: string; created_at: string }>(
    `select id, kind, pattern, reason, created_by, created_at from email_sender_rules where ${actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'} order by created_at desc limit 500`))
}
