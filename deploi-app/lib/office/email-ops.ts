/**
 * Email Operations agent. On its mailbox (the organization's Deploi office mailbox, or a connected account):
 *  1. finds inbound messages nobody has answered for N business hours — accepted mail only (quarantined mail
 *     is never answered by any agent), never automatic replies, never suppressed (bounced, complained,
 *     unsubscribed) senders, never mail already answered in its conversation, never conversations an Office
 *     lead or meeting owns (those are tracked by their own case);
 *  2. opens one `email_unanswered` case per conversation and sorts the message deterministically
 *     (inquiry, supplier, customer issue, spam-ish: keyword rules, no model call);
 *  3. drafts a templated reply to the sender (spam-ish mail gets none) and proposes it as an Office action, so
 *     the email tier decides: drafts only (the template default), each reply after approval, or without
 *     asking for the categories the policy lists;
 *  4. once the reply is accepted by the provider the case waits for the requester.
 * Resolution rule (documented, and stored on every case as its verification rule):
 *  - the requester's next reply in the conversation acknowledges it (thanks / got it, no new question): resolved,
 *    verified by that reply;
 *  - or no follow-up from the requester within `answeredAfterDays` of our reply: resolved as "answered", verified
 *    by the email engine's record of the accepted reply plus the absence of any follow-up in the mailbox. This is
 *    recorded honestly as answered, not as confirmed by the requester;
 *  - or the owner marks it handled (lib/office/resolution.ts#markOfficeCaseHandled) with the reply message or
 *    their own confirmation as evidence.
 * A follow-up that asks something else moves the case back to investigating and a new reply is drafted.
 * Outlook / Microsoft 365 and Gmail accounts connected with read access give reply senders and times only
 * (lib/email/adapters); Deploi does not list or read their inboxes, so no unanswered-message case is opened
 * for them (the run counts this). Message text is data: it only chooses a category.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { admin, type Db } from '../db'
import { addEvidence, caseForRecord, openCase, registerCaseKind, resolveCase, TERMINAL, type CaseRow, type Evidence } from '../cases'
import { agentCtx, proposeAction, type AgentCtx, type OfficeActionRow } from './actions'
import { newText } from './content'
import { actorOf, blockForStop, ensureActionRecorded, ensureLink, inboundContent, iso, moveCase, RESOLUTION_ACTOR, stepFor, stopped, type InboundMail } from './case-sync'

export type EmailCategory = 'inquiry' | 'supplier' | 'customer_issue' | 'spam_ish'
export const EMAIL_CATEGORY_LABEL: Record<EmailCategory, string> = { inquiry: 'inquiry', supplier: 'supplier', customer_issue: 'customer issue', spam_ish: 'spam-ish' }
export type BusinessHours = { timezone: string; days: number[]; dayStart: string; dayEnd: string }
export const DEFAULT_HOURS: BusinessHours = { timezone: 'UTC', days: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00' }

const SPAM = /\b(seo|backlinks?|guest posts?|crypto(currency)?|bitcoin|forex|casino|lottery|you have won|winner|limited[- ]time offer|act now|100% free|click here|increase your (traffic|rankings?|sales)|web design services|lead generation services|rank (#?1|first) on google)\b/
const ISSUE = /\b(refund|broken|damaged|defective|faulty|not working|doesn'?t work|stopped working|wrong (item|size|colou?r|order)|missing|never (arrived|received|came)|arrived late|delayed|complain(t|ing)?|problem|issue|cancel (my|the|our) order|return(ing)? (it|this|the)|charged twice|disappointed)\b/
const SUPPLIER = /\b(invoice|purchase order|p\.?o\.? ?(number|#|no\.?)? ?\d{2,}|remittance|shipment|shipping notice|delivery (date|schedule|note)|quote|quotation|price list|wholesale|supplier|vendor|restock|back ?order|statement of account|proforma)\b/

/** One category for an unanswered message, from its subject and new text (keyword rules; deterministic). */
export function classifyEmail(subject: string, text: string): EmailCategory {
  const body = newText(text)
  const t = `${subject}\n${body}`.toLowerCase()
  if (SPAM.test(t) || (body.match(/https?:\/\//g)?.length ?? 0) >= 4) return 'spam_ish'
  if (ISSUE.test(t)) return 'customer_issue'
  if (SUPPLIER.test(t)) return 'supplier'
  return 'inquiry'
}

/** The requester's next message after our reply: an acknowledgement closes the case; anything else needs a reply. */
export function classifyFollowUp(subject: string, text: string): 'acknowledged' | 'needs_reply' {
  const t = newText(text).toLowerCase().trim()
  if (!t || t.includes('?')) return 'needs_reply'
  if (t.length <= 400 && /\b(thanks|thank you|thx|cheers|got it|perfect|great|appreciated?|sounds good|all good|that works|resolved|sorted|no worries|noted|ok(ay)?)\b/.test(t)) return 'acknowledged'
  return 'needs_reply'
}

const clean = (s: string, max: number) => s.replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
export function emailOpsDraft(category: Exclude<EmailCategory, 'spam_ish'>, senderName: string, subject: string) {
  const line = category === 'customer_issue'
    ? 'Thank you for letting us know, and we are sorry for the trouble. We have your message and a member of the team is looking into it; we will get back to you shortly with next steps.'
    : category === 'supplier'
      ? 'Thank you for your message. We have received it and passed it to the person who looks after our orders and supplier accounts; they will come back to you shortly.'
      : 'Thank you for getting in touch. We have your message and a member of the team will reply with a full answer shortly.'
  const s = clean(subject, 180)
  return { subject: /^re:/i.test(s) ? s : `Re: ${s || 'your message'}`, body: `Hello,\n\n${line}\n\nBest,\n${clean(senderName, 80)}` }
}

// ---------------------------------------------------------------- business hours

/** Minutes inside business hours (local time, the given week days) between two instants. */
export function businessMinutesBetween(from: Date, to: Date, h: BusinessHours): number {
  if (to.getTime() <= from.getTime()) return 0
  let total = 0
  let d = formatInTimeZone(from, h.timezone, 'yyyy-MM-dd')
  const last = formatInTimeZone(to, h.timezone, 'yyyy-MM-dd')
  for (let n = 0; n < 62; n++) {
    const dow = Number(formatInTimeZone(fromZonedTime(`${d}T12:00:00`, h.timezone), h.timezone, 'i'))
    if (h.days.includes(dow)) {
      const s = fromZonedTime(`${d}T${h.dayStart}:00`, h.timezone).getTime(), e = fromZonedTime(`${d}T${h.dayEnd}:00`, h.timezone).getTime()
      const lo = Math.max(s, from.getTime()), hi = Math.min(e, to.getTime())
      if (hi > lo) total += (hi - lo) / 60e3
    }
    if (d === last) break
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)
  }
  return Math.floor(total)
}

// ---------------------------------------------------------------- detection

export type Unanswered = InboundMail & { business_minutes: number }

/**
 * Inbound messages on these mailboxes with no reply in their conversation for at least `hours` business hours
 * (shared by the Email Operations run and the discovery detector, so both count the same thing).
 */
export async function unansweredInbound(db: Db, orgId: string, accountIds: string[], now: Date, hours: number, bh: BusinessHours = DEFAULT_HOURS): Promise<Unanswered[]> {
  if (!accountIds.length) return []
  const rows = await db.query<InboundMail>(`select i.id, i.org_id, i.account_id, i.from_address, i.thread_message_id, i.internet_message_id, i.received_at, i.status, i.auto_reply, i.auto_reply_reason, i.classification, i.key_id, i.content_ciphertext
    from email_inbound i
    where i.org_id = $1 and i.account_id = any($2::uuid[]) and i.status = 'accepted' and not i.auto_reply and i.key_id <> 'pending'
      and i.classification not in ('merchant_forward', 'merchant_cc')
      and i.received_at > $3::timestamptz - interval '14 days' and i.received_at <= $3::timestamptz
      and not exists (select 1 from email_suppressions s where s.org_id = i.org_id and s.address = lower(i.from_address))
      and not exists (select 1 from email_accounts a where a.org_id = i.org_id and lower(a.address) = lower(i.from_address))
      and not exists (select 1 from email_messages m join office_actions oa on oa.id = m.office_action_id where m.id = i.thread_message_id and (oa.lead_id is not null or oa.meeting_id is not null))
      and not exists (select 1 from email_messages r where r.org_id = i.org_id and r.account_id = i.account_id and r.status in ('queued', 'sending', 'accepted', 'delivery_unknown')
        and lower(i.from_address) = any(r.to_addresses)
        and (r.meta->>'inbound_id' = i.id::text or r.meta->>'thread_key' = 'i:' || i.id::text or (i.internet_message_id is not null and r.in_reply_to = i.internet_message_id)
          or (i.thread_message_id is not null and coalesce(r.accepted_at, r.created_at) >= i.received_at
            and (r.meta->>'thread_key' = 'm:' || i.thread_message_id::text or r.in_reply_to = (select t.internet_message_id from email_messages t where t.id = i.thread_message_id)))))
      and not exists (select 1 from office_actions oa where oa.org_id = i.org_id and oa.kind = 'send_email' and oa.payload->'recipientSource'->>'inboundId' = i.id::text
        and oa.status in ('queued', 'executing', 'succeeded', 'unknown'))
      and not exists (select 1 from case_links cl join cases cc on cc.id = cl.case_id where cl.ref_type = 'email_inbound' and cl.ref_id = i.id::text and cc.status in ('resolved', 'cancelled'))
      and not exists (select 1 from email_inbound l where l.org_id = i.org_id and l.account_id = i.account_id and l.thread_message_id = i.thread_message_id and l.id <> i.id
        and lower(l.from_address) = lower(i.from_address) and l.status = 'accepted' and not l.auto_reply and l.received_at > i.received_at)
    order by i.received_at limit 200`, [orgId, accountIds, now.toISOString()])
  return rows.map(r => ({ ...r, business_minutes: businessMinutesBetween(new Date(r.received_at), now, bh) })).filter(r => r.business_minutes >= hours * 60)
}

export const emailDedupe = (i: Pick<InboundMail, 'id' | 'thread_message_id'>) => `email_unanswered:${i.thread_message_id ? `m:${i.thread_message_id}` : `i:${i.id}`}`
const SOURCE: Record<string, string> = { deploi: 'deploi_email', synthetic: 'deploi_email', microsoft: 'outlook', gmail: 'gmail' }
export const EMAIL_CRITERIA = 'Resolved when the requester\'s next reply acknowledges the answer; or, after our reply was accepted by the provider, when no follow-up arrives within the set number of days (recorded as "answered"); or when you mark it handled with the reply or your confirmation as evidence. Drafting or sending a reply alone never resolves it.'

// ---------------------------------------------------------------- the run

async function markHandled(ctx: AgentCtx, inboundId: string, category: string, outcome: string) {
  await admin(db => db.query(`insert into office_inbound_handled (org_id, agent_id, inbound_id, classification, outcome) values ($1,$2,$3,$4,$5) on conflict do nothing`, [ctx.agent.org_id, ctx.agent.id, inboundId, category, outcome.slice(0, 200)]))
}

export async function emailOperationsRun(ctx: AgentCtx, now: Date, counts: Record<string, number>) {
  const p = ctx.policy!, o = p.emailOps!
  const account = await admin(db => db.one<{ id: string; provider: string; address: string; status: string; can_read: boolean }>('select id, provider, address, status, can_read from email_accounts where id = $1 and org_id = $2', [p.mailboxAccountId, ctx.agent.org_id]))
  if (!account || account.status !== 'active') { counts.mailbox_unavailable = 1; return }
  // connected Gmail / Outlook accounts: reply senders and times only; their inbox is not read by Deploi
  if (account.provider === 'gmail' || account.provider === 'microsoft') counts.inbox_not_read = 1
  const bh: BusinessHours = { timezone: p.timezone, days: o.days, dayStart: o.dayStart, dayEnd: o.dayEnd }
  const found = await admin(db => unansweredInbound(db, ctx.agent.org_id, [account.id], now, o.unansweredHours, bh))
  counts.unanswered = found.length
  for (const i of found) {
    const done = await admin(db => db.one('select 1 from office_inbound_handled where agent_id = $1 and inbound_id = $2', [ctx.agent.id, i.id]))
    if (done) continue
    await handleUnanswered(ctx, i, account, now, counts)
  }
  await syncEmailCases(ctx.agent.org_id, now, { agentId: ctx.agent.id })
}

async function handleUnanswered(ctx: AgentCtx, i: Unanswered, account: { id: string; provider: string; address: string }, now: Date, counts: Record<string, number>) {
  const p = ctx.policy!, o = p.emailOps!
  const actor = actorOf(ctx)
  const content = inboundContent(i)
  const category = classifyEmail(content.subject, content.text)
  const hours = Math.floor(i.business_minutes / 60)
  const evidence: Evidence = { label: `No reply for ${hours} business hours: message from ${i.from_address} received ${iso(i.received_at).slice(0, 16).replace('T', ' ')} UTC, sorted as "${EMAIL_CATEGORY_LABEL[category]}"`,
    source: SOURCE[account.provider] ?? 'deploi_email', observedAt: now.toISOString(), ref: { type: 'email_inbound', id: i.id }, detail: { category, business_hours: hours, mailbox: account.address } }
  // a follow-up in a conversation we already answered belongs to that conversation's open case
  let c: CaseRow | null = i.thread_message_id ? await admin(db => caseForRecord(db, ctx.agent.org_id, 'email_message', i.thread_message_id!)) : null
  if (c && TERMINAL.includes(c.status)) c = null
  if (c) {
    await ensureLink(c.id, { type: 'email_inbound', id: i.id, label: `Message from ${i.from_address}` }, actor)
    await admin(db => addEvidence(db, c!.id, evidence, actor))
  } else {
    c = (await admin(db => openCase(db, {
      orgId: ctx.agent.org_id, suite: 'office', kind: 'email_unanswered', sourceApp: SOURCE[account.provider] ?? 'deploi_email', dedupeKey: emailDedupe(i),
      title: `Unanswered ${EMAIL_CATEGORY_LABEL[category]} from ${i.from_address}`.slice(0, 300),
      problem: `A message to ${account.address} from ${i.from_address}, received ${iso(i.received_at).slice(0, 16).replace('T', ' ')} UTC, has had no reply for ${hours} business hours.`,
      whyItMatters: category === 'customer_issue' ? 'A customer with a problem who hears nothing tends to escalate, ask for a refund or leave.' : category === 'supplier' ? 'Supplier questions left unanswered hold up orders and invoices.' : 'An enquiry nobody answers is lost business.',
      priority: category === 'customer_issue' ? 'high' : category === 'spam_ish' ? 'low' : 'normal',
      agent: { kind: 'office', ref: ctx.agent.id }, evidence: [evidence],
      records: [{ type: 'email_inbound', id: i.id, label: `Message from ${i.from_address}` }],
      verification: { criteria: EMAIL_CRITERIA, rule: { kind: 'email_unanswered', acknowledged_by: 'the requester\'s next reply without a new question', answered_after_days: o.answeredAfterDays, or: 'owner marks it handled with evidence' } },
      nextAction: 'Draft a reply to the sender.', actor,
    }))).case
  }
  if (category === 'spam_ish') {
    await moveCase(c.id, { status: 'escalated', reason: 'Looks like unsolicited mail (spam-ish): no reply was drafted', nextAction: 'Close the case, or answer it yourself if it is real.', nextCheckAt: null }, actor)
    await markHandled(ctx, i.id, category, 'spam-ish: nothing drafted')
    counts.spam = (counts.spam ?? 0) + 1
    return
  }
  await moveCase(c.id, { status: 'investigating', reason: `Sorted as "${EMAIL_CATEGORY_LABEL[category]}"; drafting a reply to ${i.from_address}` }, actor)
  const d = emailOpsDraft(category, o.senderName, content.subject)
  const may = (o.sendCategories as string[]).includes(category)
  const { action } = await admin(db => proposeAction(db, { agentId: ctx.agent.id, kind: 'send_email', purpose: `Reply to an unanswered ${EMAIL_CATEGORY_LABEL[category]}`, idempotencyKey: `emailops:${ctx.agent.id}:${i.id}`, now,
    payload: { type: 'email', to: i.from_address, subject: d.subject, body: d.body, inReplyToMessageId: i.thread_message_id, recipientSource: { kind: 'inbound', inboundId: i.id }, meta: { category, subject: d.subject, inbound_id: i.id, case_ref: c!.ref } },
    standingBlockers: may ? [] : [`replies to a ${EMAIL_CATEGORY_LABEL[category]} always wait for a person`] }))
  await ensureLink(c.id, { type: 'office_action', id: action.id, label: action.purpose }, actor)
  await markHandled(ctx, i.id, category, 'reply drafted')
  counts.replies_drafted = (counts.replies_drafted ?? 0) + 1
}

// ---------------------------------------------------------------- case sync and the durable check

export async function syncEmailCases(orgId: string, now: Date, opts: { agentId?: string } = {}) {
  const open = await admin(db => db.query<{ id: string }>(`select id from cases where org_id = $1 and kind = 'email_unanswered' and status not in ('resolved','cancelled') and ($2::text is null or agent_ref = $2) order by updated_at limit 200`, [orgId, opts.agentId ?? null]))
  for (const c of open) await syncEmailCase(c.id, now)
}

/** Carry an email_unanswered case forward from its records: the reply action, the sent message, the requester's next message. */
export async function syncEmailCase(caseId: string, now: Date) {
  const c = await admin(db => db.one<CaseRow>('select * from cases where id = $1', [caseId]))
  if (!c || TERMINAL.includes(c.status)) return
  const stop = await stopped(c.org_id)
  if (stop) { await blockForStop(c.org_id, stop, { caseId }); return }
  const ctx = c.agent_kind === 'office' && c.agent_ref ? await admin(db => agentCtx(db, c.agent_ref!)) : null
  const actor = actorOf(ctx)
  const days = ctx?.policy?.emailOps?.answeredAfterDays ?? 3
  const inbound = await admin(db => db.query<InboundMail>(`select i.* from email_inbound i join case_links l on l.ref_type = 'email_inbound' and l.ref_id = i.id::text where l.case_id = $1 order by i.received_at`, [c.id]))
  const latest = inbound[inbound.length - 1]
  if (!latest) return
  const acts = await admin(db => db.query<OfficeActionRow>(`select a.* from office_actions a join case_links l on l.ref_type = 'office_action' and l.ref_id = a.id::text where l.case_id = $1 order by a.created_at`, [c.id]))
  const mine = [...acts].reverse().find(a => a.payload.type === 'email' && a.payload.recipientSource.kind === 'inbound' && a.payload.recipientSource.inboundId === latest.id) ?? null
  // a reply someone else sent in the conversation (a person from the inbox, another agent)
  const other = await admin(db => db.one<{ id: string; accepted_at: string | null; created_at: string; status: string }>(`select r.id, r.accepted_at, r.created_at, r.status from email_messages r where r.org_id = $1 and r.account_id = $2 and r.status = 'accepted' and lower($3) = any(r.to_addresses)
    and (r.meta->>'inbound_id' = $4 or r.meta->>'thread_key' = 'i:' || $4 or ($5::text is not null and r.in_reply_to = $5)) order by r.accepted_at limit 1`, [c.org_id, latest.account_id, latest.from_address, latest.id, latest.internet_message_id]))
  let sent: { id: string; at: string; by: string } | null = null
  if (mine?.status === 'succeeded' && mine.email_message_id) {
    const m = await admin(db => db.one<{ id: string; accepted_at: string | null; created_at: string }>('select id, accepted_at, created_at from email_messages where id = $1', [mine.email_message_id]))
    if (m) {
      sent = { id: m.id, at: m.accepted_at ?? m.created_at, by: 'the Email Operations agent' }
      await ensureActionRecorded(c.id, { summary: `Reply sent to ${latest.from_address} (accepted by the provider; not proof of delivery)`, ref: { type: 'email_message', id: m.id }, detail: { office_action_id: mine.id, approval: mine.approval_kind } }, actor)
    }
  } else if (other) {
    sent = { id: other.id, at: other.accepted_at ?? other.created_at, by: 'someone in the conversation' }
    await ensureActionRecorded(c.id, { summary: `Answered in the conversation (message accepted by the provider)`, ref: { type: 'email_message', id: other.id } }, actor)
  } else if (mine?.status === 'rejected') {
    await moveCase(c.id, { status: 'escalated', reason: 'You declined the drafted reply', nextAction: 'Answer it yourself and mark the case handled, or close it.', nextCheckAt: null }, actor); return
  } else if (mine) {
    await moveCase(c.id, stepFor(mine, 'Reply'), actor); return
  } else return
  if (!sent) return
  // after the reply: the requester's next message in that conversation decides
  const follow = await admin(db => db.one<InboundMail>(`select * from email_inbound where org_id = $1 and thread_message_id = $2 and lower(from_address) = lower($3) and status = 'accepted' and not auto_reply order by received_at limit 1`, [c.org_id, sent.id, latest.from_address]))
  if (follow) {
    await ensureLink(c.id, { type: 'email_inbound', id: follow.id, label: `Reply from ${follow.from_address}` }, actor)
    const body = inboundContent(follow)
    const verdict = classifyFollowUp(body.subject, body.text)
    const ev: Evidence = { label: `${follow.from_address} replied ${iso(follow.received_at).slice(0, 16).replace('T', ' ')} UTC: ${verdict === 'acknowledged' ? 'acknowledged the answer' : 'wrote back with something that needs a reply'}`, source: 'deploi_email', observedAt: iso(follow.received_at), ref: { type: 'email_inbound', id: follow.id }, detail: { verdict } }
    if (verdict === 'acknowledged') {
      await moveCase(c.id, { status: 'verifying', reason: 'The requester replied; checking it acknowledges the answer' }, actor)
      await admin(db => resolveCase(db, c.id, { actor, summary: `Answered and acknowledged by ${follow.from_address}`, verifiedBy: 'the requester\'s reply in the mailbox', evidence: [ev] }))
      return
    }
    await moveCase(c.id, { status: 'investigating', reason: `${follow.from_address} wrote back with something that needs a reply`, nextAction: 'The Email Operations agent drafts another reply once the message is unanswered.', evidence: [ev], nextCheckAt: new Date(now.getTime() + 4 * 3600e3) }, actor)
    return
  }
  const due = new Date(new Date(sent.at).getTime() + days * 864e5)
  if (now.getTime() >= due.getTime()) {
    await moveCase(c.id, { status: 'verifying', reason: `No follow-up from ${latest.from_address} in ${days} day${days === 1 ? '' : 's'} after the reply` }, actor)
    await admin(db => resolveCase(db, c.id, { actor, summary: `Answered: reply accepted ${iso(sent!.at).slice(0, 10)}; no follow-up question from ${latest.from_address} within ${days} day${days === 1 ? '' : 's'} (recorded as answered, not confirmed by the requester)`,
      verifiedBy: 'the email engine record of the accepted reply and the mailbox (no follow-up received)',
      evidence: [
        { label: `Reply to ${latest.from_address} accepted by the provider ${iso(sent.at).slice(0, 16).replace('T', ' ')} UTC (sent by ${sent.by})`, source: 'deploi_email', observedAt: iso(sent.at), ref: { type: 'email_message', id: sent.id } },
        { label: `No message from ${latest.from_address} in the conversation for ${days} day${days === 1 ? '' : 's'} after the reply`, source: 'deploi_email', observedAt: now.toISOString(), detail: { rule: 'answered_after_days', days } },
      ] }))
    return
  }
  await moveCase(c.id, { status: 'waiting_external', reason: `Replied to ${latest.from_address}; waiting ${days} day${days === 1 ? '' : 's'} for a follow-up`, nextAction: null, nextCheckAt: due }, actor)
}

registerCaseKind('email_unanswered', async (c, now) => { await syncEmailCase(c.id, now) })

export { RESOLUTION_ACTOR }
