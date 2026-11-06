/**
 * Home services pack (construction, HVAC, roofing, landscaping, cleaning). Seven agents, each on the shared
 * loop (detect -> act -> verify -> proof -> owner update), rules and templates only:
 *
 *   hs_lead_reply      a new lead email gets the trade's reply within minutes, with three quote-visit times
 *   hs_quote_booking   the lead's "2" books that visit on the calendar and confirms it
 *   hs_quote_followup  quiet quotes are followed up on a cadence; YES accepts, NO closes; then the owner is told
 *   hs_dispatch        a scheduled job goes to its crew member with the details; no confirmation -> reminder -> owner
 *   hs_invoice         the crew's DONE creates the invoice in QuickBooks and sends it
 *   hs_payment_chase   late invoices are chased (the receivables rules and reminder text); a partial payment is noted
 *   hs_review_request  a paid job gets a thank-you with the review link
 */
import { randomBytes } from 'node:crypto'
import type { Db } from '../db'
import { onEvent, type AgentEvent } from '../events'
import { notifyCrew } from '../notify'
import { formatDate, formatMoney, overdueStatus, reminderDraft } from '../office/receivables'
import { slotLabel, type Slot } from '../office/slots'
import { registerPackAgents, type PackAgent } from './registry'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { emailLeadSource, intakeLead, type LeadRow } from './leads'
import { sendPackMessage, verifySent, policyProof } from './outbound'
import { PortError, portsFor } from './ports'
import { orgPacks, type OrgPacks } from './settings'
import { bookSlot, openSlots, slotChoice, verifyEvent, HORIZON_DAYS } from './scheduling'
import { bookingConfirmation, crewDispatch, homeLeadReply, paymentThanksReview, quoteFollowUp, slotsAgain, tradeJob } from './templates'
import { sweepLeadFollowUps } from './lead-followup'
import { addressOf, days, eventNow, hours, isoDay, leadFrom, optedOut, replyText, rowProof, saysNo, saysYes, str } from './kit'

const PACK = 'home_services' as const
const PATH = '/store/packs/home_services'
export const HOME_AGENTS: PackAgent[] = [
  { key: 'hs_lead_reply', name: 'Lead responder', pack: PACK, job: 'Replies to every new lead within minutes with your trade\'s message and three quote-visit times.', triggers: ['lead.email'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_quote_booking', name: 'Quote visit booker', pack: PACK, job: 'Books the quote visit the customer picks on your calendar and confirms it.', triggers: ['mail.received'], actions: ['book_appointment', 'send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_quote_followup', name: 'Quote follow-up', pack: PACK, job: 'Follows up quotes that went quiet, and records a yes or no.', triggers: ['sweep', 'mail.received'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_dispatch', name: 'Crew dispatcher', pack: PACK, job: 'Sends each scheduled job to its crew member with the address, time and work, and chases a confirmation.', triggers: ['sweep', 'crew.confirmed'], actions: ['notify_crew'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_invoice', name: 'Job invoicer', pack: PACK, job: 'When the crew says the job is done, creates and sends the invoice in QuickBooks.', triggers: ['crew.done'], actions: ['invoice_send'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_payment_chase', name: 'Payment chaser', pack: PACK, job: 'Chases late invoices on a schedule and notes part payments; tells you when it is paid.', triggers: ['sweep', 'quickbooks.payment'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'hs_review_request', name: 'Review requester', pack: PACK, job: 'Thanks the customer after a paid job and asks for a review.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
]
registerPackAgents(HOME_AGENTS)
const NAME = Object.fromEntries(HOME_AGENTS.map(a => [a.key, a.name])) as Record<string, string>

export type WorkOrder = {
  id: string; org_id: string; ref: string; lead_id: string | null; customer_name: string | null; customer_email: string | null; customer_phone: string | null; address: string | null
  description: string; amount: string | null; currency: string; crew_member_id: string | null; scheduled_start: string | null; status: string; quote_sent_at: string | null; quote_follow_ups: number
  next_quote_follow_up_at: string | null; dispatched_at: string | null; dispatch_reminders: number; crew_confirmed_at: string | null; crew_escalated_at: string | null; done_at: string | null
  invoice_external_id: string | null; invoice_number: string | null; invoiced_at: string | null; invoice_due_date: string | null; invoice_balance: string | null; payment_reminders: number
  last_payment_reminder_at: string | null; payment_escalated_at: string | null; paid_at: string | null; review_requested_at: string | null; pack: string
}
const money = (wo: Pick<WorkOrder, 'amount' | 'currency'>, n?: number | string | null) => formatMoney(n ?? wo.amount, wo.currency)

// ---------------------------------------------------------------- records the owner (or the API) creates

/** A quote the business sent: the follow-up agent takes it from here. */
export async function recordQuote(db: Db, orgId: string, q: { leadId?: string | null; customerName?: string | null; customerEmail?: string | null; customerPhone?: string | null; address?: string | null; description: string; amount: number; now?: Date; pack?: 'home_services' | 'office' }) {
  const now = q.now ?? new Date()
  const cfg = (await orgPacks(db, orgId)).config
  const lead = q.leadId ? await db.one<LeadRow>('select * from pack_leads where id = $1 and org_id = $2', [q.leadId, orgId]) : null
  if (q.leadId && !lead) throw new PackBlocked('that lead is not in this organization')
  const email = addressOf(q.customerEmail ?? lead?.email)
  if (!(q.amount > 0)) throw new PackBlocked('a quote needs an amount above zero')
  const ref = `Q-${randomBytes(3).toString('hex').toUpperCase()}`
  const wo = (await db.one<WorkOrder>(`insert into pack_work_orders (org_id, pack, ref, lead_id, customer_name, customer_email, customer_phone, address, description, amount, currency, status, quote_sent_at, next_quote_follow_up_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'quoted',$12,$13) returning *`,
    [orgId, q.pack ?? PACK, ref, lead?.id ?? null, q.customerName ?? lead?.name ?? null, email, q.customerPhone ?? lead?.phone ?? null, q.address ?? null, q.description.slice(0, 2000), Math.round(q.amount * 100) / 100, cfg.currency,
      now.toISOString(), new Date(now.getTime() + days(cfg.quoteFollowUpDays[0] ?? 3)).toISOString()]))!
  if (lead) await db.query(`update pack_leads set status = 'quoted', next_follow_up_at = null where id = $1`, [lead.id])
  return wo
}

/** The owner schedules an accepted job with a crew member; the dispatcher sends it. */
export async function scheduleJob(db: Db, orgId: string, workOrderId: string, s: { crewMemberId: string; start: Date }) {
  const crew = await db.one<{ id: string }>('select id from pack_crew_members where id = $1 and org_id = $2 and active', [s.crewMemberId, orgId])
  if (!crew) throw new PackBlocked('that crew member is not active in this organization')
  const r = await db.one<WorkOrder>(`update pack_work_orders set status = 'scheduled', crew_member_id = $3, scheduled_start = $4, dispatched_at = null, dispatch_reminders = 0, crew_confirmed_at = null, crew_escalated_at = null
    where id = $1 and org_id = $2 and status in ('quoted','accepted','scheduled','dispatched','confirmed','quiet') returning *`, [workOrderId, orgId, s.crewMemberId, s.start.toISOString()])
  if (!r) throw new PackBlocked('that job cannot be scheduled from its current state')
  return r
}

// ---------------------------------------------------------------- hs_lead_reply

export async function onHomeLead(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const parsed = emailLeadSource.parse(e.payload)
  if (!parsed) return null
  const { lead, kind } = await intakeLead(db, e.orgId, PACK, parsed, 'service')
  const now = eventNow(e)
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'hs_lead_reply', agentName: NAME.hs_lead_reply, actionType: 'send_customer_email', problemKey: `lead:${lead.id}:reply`, detailsPath: PATH,
    detect: async d => {
      if (kind !== 'new') return null
      const l = await d.one<LeadRow>(`select * from pack_leads where id = $1 and status = 'new'`, [lead.id])
      if (!l) return null
      let slots: Slot[] = [], calendar: 'ok' | 'full' | 'unreachable' = 'ok'
      try { slots = await openSlots(e.orgId, org.config, org.config.visitMinutes, now); if (!slots.length) calendar = 'full' } catch { calendar = 'unreachable' }
      return { l, slots, calendar }
    },
    describe: p => ({
      title: `New lead${p.l.name ? ` from ${p.l.name}` : ''}: replied`,
      whatHappened: `A new lead came in (${p.l.source.replace('_', '.')}) about ${tradeJob(org.trade)}.`,
      whatIDid: [p.slots.length ? `Replied with your ${org.trade} message and three quote-visit times.` : p.calendar === 'full' ? `Replied and asked for times: your calendar is full for the next ${HORIZON_DAYS} days.` : 'Replied and asked for times: the calendar did not answer.'],
    }),
    act: async (d, p) => {
      if (!p.l.email) throw new PackBlocked('the lead gave no email address to reply to; call them on the number in the lead')
      const draft = homeLeadReply({ name: p.l.name, business: org.config.senderName, trade: org.trade, slots: p.slots, horizonDays: HORIZON_DAYS })
      const sent = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_lead_reply', leadId: p.l.id, to: p.l.email, ...draft, dedupeKey: `hs:lead:${p.l.id}:reply`, policy: 'general', recipientNames: [p.l.name] })
      if (sent.status !== 'sent') throw new PackBlocked(sent.status === 'blocked' ? `the reply failed the content check (${sent.policy.violations.map(v => v.term).join(', ')})` : sent.error)
      await d.query(`update pack_leads set status = $2, replied_at = $3, proposed_slots = $4, next_follow_up_at = $5 where id = $1`,
        [p.l.id, p.slots.length ? 'slots_offered' : 'replied', now.toISOString(), JSON.stringify(p.slots), new Date(now.getTime() + days(org.config.leadFollowUpDays[0] ?? 2)).toISOString()])
      ;(p as typeof p & { messageId: string }).messageId = sent.messageId
      return { proof: [policyProof(sent.policy), rowProof('Reply sent to', p.l.email)] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Reply'),
  })
}

// ---------------------------------------------------------------- hs_quote_booking

export async function onHomeReply(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK) && !org.packs.includes('office')) return null
  const from = addressOf(e.payload.from)
  const text = replyText(e.payload.subject, e.payload.text)
  const now = eventNow(e)
  const out: unknown[] = []
  // a reply to our quote-visit times
  const lead = org.packs.includes(PACK) ? await leadFrom(db, e.orgId, [PACK], from, ['slots_offered']) : null
  if (lead && !optedOut(text)) out.push(await bookFromReply(db, e, org, lead, text, now))
  // a reply to a quote
  const wo = from ? await db.one<WorkOrder>(`select * from pack_work_orders where org_id = $1 and lower(customer_email) = $2 and status in ('quoted','quiet') order by created_at desc limit 1`, [e.orgId, from]) : null
  if (wo) out.push(await quoteAnswer(db, e, wo, text, optedOut(text)))
  return out
}

async function bookFromReply(db: Db, e: AgentEvent, org: OrgPacks, lead: LeadRow, text: string, now: Date) {
  const n = slotChoice(text)
  const msg = str(e.payload.messageId, 200) ?? e.externalId
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'hs_quote_booking', agentName: NAME.hs_quote_booking, actionType: 'book_appointment', problemKey: `lead:${lead.id}:book:${msg}`, detailsPath: PATH,
    detect: async () => (n && lead.proposed_slots[n - 1] ? { slot: lead.proposed_slots[n - 1] } : null),
    describe: p => ({ title: `Quote visit booked${lead.name ? ` with ${lead.name}` : ''}`, whatHappened: `${lead.name ?? 'The lead'} picked a quote-visit time (${p.slot.label}).`, whatIDid: ['Booked it on your calendar and sent the customer a confirmation.'] }),
    act: async (d, p) => {
      const ctx = p as typeof p & { eventId?: string; messageId?: string; rebooked?: boolean }
      try {
        const b = await bookSlot(d, e.orgId, { leadId: lead.id, kind: 'quote_visit', slot: p.slot, summary: `Quote visit: ${lead.name ?? lead.email}`, description: `Lead ${lead.id}`, attendee: lead.email, timezone: org.config.timezone })
        ctx.eventId = b.eventId
      } catch (err) {
        if (!(err instanceof PortError) || err.code !== 'refused') throw err
        // the time was taken in the meantime: offer the next open times
        const slots = await openSlots(e.orgId, org.config, org.config.visitMinutes, now)
        if (!slots.length) throw new PackBlocked('the chosen time was taken and the calendar is now full; please call the customer')
        const again = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_quote_booking', leadId: lead.id, to: lead.email!, ...slotsAgain({ name: lead.name, business: org.config.senderName, slots }), dedupeKey: `hs:lead:${lead.id}:slots:${slots[0].start}`, policy: 'general', recipientNames: [lead.name] })
        if (again.status !== 'sent') throw new PackBlocked('the chosen time was taken and the new times could not be sent')
        await d.query(`update pack_leads set proposed_slots = $2 where id = $1`, [lead.id, JSON.stringify(slots)])
        ctx.messageId = again.messageId; ctx.rebooked = true
        return { proof: [rowProof('Chosen time was taken; new times sent', slots.map(s => s.label).join('; '))] }
      }
      const c = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_quote_booking', leadId: lead.id, to: lead.email!, ...bookingConfirmation({ name: lead.name, business: org.config.senderName, what: 'a free quote visit', slot: p.slot }), dedupeKey: `hs:lead:${lead.id}:booked`, policy: 'general', recipientNames: [lead.name] })
      if (c.status !== 'sent') throw new PackBlocked('the visit is booked but the confirmation could not be sent')
      ctx.messageId = c.messageId
      await d.query(`update pack_leads set status = 'booked', next_follow_up_at = null where id = $1`, [lead.id])
      return { proof: [policyProof(c.policy)] }
    },
    verify: async (_d, p) => {
      const ctx = p as typeof p & { eventId?: string; messageId?: string; rebooked?: boolean }
      const m = await verifySent(e.orgId, ctx.messageId!, ctx.rebooked ? 'New times' : 'Confirmation')
      if (ctx.rebooked) return m
      const ev = await verifyEvent(e.orgId, ctx.eventId!, p.slot.start)
      return { ok: ev.ok && m.ok, proof: [...ev.proof, ...m.proof] }
    },
  })
}

// ---------------------------------------------------------------- hs_quote_followup

async function quoteAnswer(db: Db, e: AgentEvent, wo: WorkOrder, text: string, optOut: boolean) {
  const answer = optOut ? 'stop' : saysNo(text) ? 'no' : saysYes(text) ? 'yes' : null
  return runPackLoop(db, wo.pack === 'office' ? 'office' : PACK, {
    orgId: e.orgId, agentKey: 'hs_quote_followup', agentName: NAME.hs_quote_followup, actionType: 'update_record', problemKey: `wo:${wo.id}:answer:${e.externalId}`, detailsPath: PATH,
    detect: async () => (answer ? { answer } : null),
    describe: p => ({ title: `Quote ${wo.ref}: ${p.answer === 'yes' ? 'accepted' : p.answer === 'no' ? 'declined' : 'customer asked us to stop'}`, whatHappened: `${wo.customer_name ?? 'The customer'} replied to quote ${wo.ref} (${money(wo)}).`,
      whatIDid: [p.answer === 'yes' ? 'Marked the quote accepted and stopped the follow-ups. Schedule the job with a crew member and I will dispatch it.' : 'Closed the quote and stopped the follow-ups.'] }),
    act: async (d, p) => {
      await d.query(`update pack_work_orders set status = $2, status_reason = $3, next_quote_follow_up_at = null where id = $1`, [wo.id, p.answer === 'yes' ? 'accepted' : 'cancelled', p.answer === 'yes' ? 'the customer said yes' : p.answer === 'no' ? 'the customer said no' : 'the customer asked us to stop'])
      if (wo.lead_id) await d.query(`update pack_leads set status = $2 where id = $1`, [wo.lead_id, p.answer === 'yes' ? 'won' : p.answer === 'no' ? 'lost' : 'stopped'])
      return { undo: { kind: 'work_order_status', payload: { workOrderId: wo.id, status: wo.status, nextFollowUpAt: wo.next_quote_follow_up_at } } }
    },
    verify: async (d, p) => {
      const r = await d.one<{ status: string }>('select status from pack_work_orders where id = $1', [wo.id])
      const want = p.answer === 'yes' ? 'accepted' : 'cancelled'
      return { ok: r?.status === want, proof: [rowProof('Quote status now', r?.status ?? 'missing')] }
    },
  })
}

export async function sweepQuotes(db: Db, e: AgentEvent, org: OrgPacks, pack: 'home_services' | 'office' = PACK) {
  const now = eventNow(e)
  const max = org.config.quoteFollowUpDays.length
  const due = await db.query<WorkOrder>(`select * from pack_work_orders where org_id = $1 and pack = $2 and status = 'quoted' and next_quote_follow_up_at <= $3 order by next_quote_follow_up_at limit 50`, [e.orgId, pack, now.toISOString()])
  const out: PackOutcome[] = []
  for (const wo of due) {
    const n = wo.quote_follow_ups + 1
    if (n > max) {
      out.push(await runPackLoop(db, pack, {
        orgId: e.orgId, agentKey: 'hs_quote_followup', agentName: NAME.hs_quote_followup, actionType: 'update_record', problemKey: `wo:${wo.id}:quiet`, detailsPath: PATH,
        detect: async () => wo,
        describe: () => ({ title: `Quote ${wo.ref} went quiet`, whatHappened: `${wo.customer_name ?? 'The customer'} has not answered quote ${wo.ref} (${money(wo)}) after ${max} follow-ups.`, whatIDid: ['Stopped following up and marked the quote quiet. You may want to call them.'] }),
        act: async d => { await d.query(`update pack_work_orders set status = 'quiet', status_reason = 'no answer after every follow-up', next_quote_follow_up_at = null where id = $1`, [wo.id]); return {} },
        verify: async d => { const r = await d.one<{ status: string }>('select status from pack_work_orders where id = $1', [wo.id]); return { ok: r?.status === 'quiet', proof: [rowProof('Quote status now', r?.status ?? 'missing')] } },
      }))
      continue
    }
    out.push(await runPackLoop(db, pack, {
      orgId: e.orgId, agentKey: 'hs_quote_followup', agentName: NAME.hs_quote_followup, actionType: 'send_customer_email', problemKey: `wo:${wo.id}:followup:${n}`, detailsPath: PATH,
      detect: async () => wo,
      describe: () => ({ title: `Quote ${wo.ref}: follow-up ${n} of ${max}`, whatHappened: `Quote ${wo.ref} (${money(wo)}) has had no answer.`, whatIDid: [`Sent follow-up ${n} of ${max} to ${wo.customer_name ?? 'the customer'}.`] }),
      act: async (d, p) => {
        if (!wo.customer_email) throw new PackBlocked(`quote ${wo.ref} has no customer email address`)
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_quote_followup', leadId: wo.lead_id, to: wo.customer_email, ...quoteFollowUp({ name: wo.customer_name, business: org.config.senderName, ref: wo.ref, amount: money(wo), n, max }), dedupeKey: `hs:wo:${wo.id}:followup:${n}`, policy: 'general', recipientNames: [wo.customer_name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the follow-up failed the content check' : s.error)
        const next = n < max ? org.config.quoteFollowUpDays[n] - org.config.quoteFollowUpDays[n - 1] : 7
        await d.query(`update pack_work_orders set quote_follow_ups = $2, next_quote_follow_up_at = $3 where id = $1`, [wo.id, n, new Date(now.getTime() + days(Math.max(1, next))).toISOString()])
        ;(p as WorkOrder & { messageId?: string }).messageId = s.messageId
        return { proof: [policyProof(s.policy)] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as WorkOrder & { messageId?: string }).messageId!, 'Follow-up'),
    }))
  }
  return out
}

// ---------------------------------------------------------------- hs_dispatch

type Crew = { id: string; name: string; email: string | null; phone: string | null }
const crewOf = (db: Db, wo: WorkOrder) => (wo.crew_member_id ? db.one<Crew>('select id, name, email, phone from pack_crew_members where id = $1 and org_id = $2', [wo.crew_member_id, wo.org_id]) : Promise.resolve(null))
const crewOk = (s: string) => s === 'sent' || s === 'queued' || s === 'held'

export async function sweepDispatch(db: Db, e: AgentEvent, org: OrgPacks, pack: 'home_services' | 'office' = PACK) {
  const now = eventNow(e)
  const out: PackOutcome[] = []
  const toSend = await db.query<WorkOrder>(`select * from pack_work_orders where org_id = $1 and pack = $2 and status = 'scheduled' and scheduled_start is not null and scheduled_start <= $3 order by scheduled_start limit 50`,
    [e.orgId, pack, new Date(now.getTime() + hours(36)).toISOString()])
  for (const wo of toSend) {
    const when = slotLabel(wo.scheduled_start!, org.config.timezone)
    out.push(await runPackLoop(db, pack, {
      orgId: e.orgId, agentKey: 'hs_dispatch', agentName: NAME.hs_dispatch, actionType: 'notify_crew', problemKey: `wo:${wo.id}:dispatch:${wo.scheduled_start}:${wo.crew_member_id}`, detailsPath: PATH,
      detect: async d => ({ wo, crew: await crewOf(d, wo) }),
      describe: p => ({ title: `Job ${wo.ref} sent to ${p.crew?.name ?? 'the crew'}`, whatHappened: `Job ${wo.ref} is scheduled for ${when}.`, whatIDid: [`Sent ${p.crew?.name ?? 'the crew member'} the address, time, customer and work.`] }),
      act: async (d, p) => {
        if (!p.crew) throw new PackBlocked(`job ${wo.ref} has no crew member`)
        const msg = crewDispatch({ crewName: p.crew.name, ref: wo.ref, when, address: wo.address, customer: wo.customer_name, phone: wo.customer_phone, description: wo.description })
        const r = await notifyCrew({ orgId: e.orgId, crewMemberId: p.crew.id, jobRef: wo.ref, ...msg, address: wo.address, dedupeKey: `hs:wo:${wo.id}:dispatch:${wo.scheduled_start}:${p.crew.id}` })
        ;(p as typeof p & { result?: string }).result = r.status
        if (!crewOk(r.status)) return { proof: [rowProof('Crew message', `${r.status}${r.reason ? `: ${r.reason}` : ''}`)] }
        await d.query(`update pack_work_orders set status = 'dispatched', dispatched_at = $2 where id = $1`, [wo.id, now.toISOString()])
        return { proof: [rowProof('Crew message', `${r.status} (${r.id ?? 'no id'})`)] }
      },
      verify: async (d, p) => {
        const r = await d.one<{ status: string }>('select status from pack_work_orders where id = $1', [wo.id])
        const sent = crewOk((p as typeof p & { result?: string }).result ?? '')
        return { ok: sent && r?.status === 'dispatched', proof: [rowProof('Job status now', r?.status ?? 'missing')] }
      },
    }))
  }
  // dispatched, never confirmed: one reminder, then the owner
  const quiet = await db.query<WorkOrder>(`select * from pack_work_orders where org_id = $1 and pack = $2 and status = 'dispatched' and crew_confirmed_at is null and dispatched_at <= $3 order by dispatched_at limit 50`,
    [e.orgId, pack, new Date(now.getTime() - hours(org.config.confirmReminderHours)).toISOString()])
  for (const wo of quiet) {
    const overdue = Date.parse(wo.dispatched_at!) <= now.getTime() - hours(org.config.confirmEscalateHours)
    if (overdue && !wo.crew_escalated_at) {
      out.push(await runPackLoop(db, pack, {
        orgId: e.orgId, agentKey: 'hs_dispatch', agentName: NAME.hs_dispatch, actionType: 'notify_owner', problemKey: `wo:${wo.id}:noconfirm:${wo.dispatched_at}`, detailsPath: PATH,
        detect: async d => ({ crew: await crewOf(d, wo) }),
        describe: p => ({ title: `${p.crew?.name ?? 'The crew'} has not confirmed job ${wo.ref}`, whatHappened: `Job ${wo.ref} was sent ${org.config.confirmEscalateHours} hours ago and reminded once, with no confirmation.`, whatIDid: ['Flagged it for you: please call the crew member or reassign the job.'] }),
        act: async d => { await d.query(`update pack_work_orders set crew_escalated_at = $2 where id = $1`, [wo.id, now.toISOString()]); return {} },
        verify: async d => { const r = await d.one<{ crew_escalated_at: string | null }>('select crew_escalated_at from pack_work_orders where id = $1', [wo.id]); return { ok: Boolean(r?.crew_escalated_at), proof: [rowProof('Flagged at', String(r?.crew_escalated_at ?? 'not set'))] } },
      }))
    } else if (!overdue && wo.dispatch_reminders === 0) {
      out.push(await runPackLoop(db, pack, {
        orgId: e.orgId, agentKey: 'hs_dispatch', agentName: NAME.hs_dispatch, actionType: 'notify_crew', problemKey: `wo:${wo.id}:remind:${wo.dispatched_at}`, detailsPath: PATH,
        detect: async d => ({ crew: await crewOf(d, wo) }),
        describe: p => ({ title: `Reminded ${p.crew?.name ?? 'the crew'} about job ${wo.ref}`, whatHappened: `Job ${wo.ref} has not been confirmed.`, whatIDid: ['Sent the crew member a reminder.'] }),
        act: async (d, p) => {
          if (!p.crew) throw new PackBlocked(`job ${wo.ref} has no crew member`)
          const r = await notifyCrew({ orgId: e.orgId, crewMemberId: p.crew.id, jobRef: wo.ref, subject: `Reminder: please confirm job ${wo.ref}`, body: `Hi ${p.crew.name.split(' ')[0]},\n\nPlease reply CONFIRM for job ${wo.ref} (${slotLabel(wo.scheduled_start!, org.config.timezone)}).`, address: wo.address, dedupeKey: `hs:wo:${wo.id}:remind:${wo.dispatched_at}` })
          ;(p as typeof p & { result?: string }).result = r.status
          await d.query(`update pack_work_orders set dispatch_reminders = dispatch_reminders + 1 where id = $1`, [wo.id])
          return { proof: [rowProof('Reminder', r.status)] }
        },
        verify: async (_d, p) => ({ ok: crewOk((p as typeof p & { result?: string }).result ?? ''), proof: [] }),
      }))
    }
  }
  return out
}

export async function onCrewConfirmed(db: Db, e: AgentEvent) {
  const ref = str(e.payload.jobRef, 40)
  if (!ref) return null
  const r = await db.query(`update pack_work_orders set status = 'confirmed', crew_confirmed_at = $3 where org_id = $1 and ref = $2 and status = 'dispatched' returning id`, [e.orgId, ref, eventNow(e).toISOString()])
  return r.length ? { confirmed: ref } : null
}

// ---------------------------------------------------------------- hs_invoice

export async function onCrewDone(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  const ref = str(e.payload.jobRef, 40)
  if (!ref) return null
  const wo = await db.one<WorkOrder>(`select * from pack_work_orders where org_id = $1 and ref = $2`, [e.orgId, ref])
  if (!wo || !org.packs.includes(wo.pack as 'home_services' | 'office')) return null
  const now = eventNow(e)
  return runPackLoop(db, wo.pack as 'home_services' | 'office', {
    orgId: e.orgId, agentKey: 'hs_invoice', agentName: NAME.hs_invoice, actionType: 'invoice_send', problemKey: `wo:${wo.id}:invoice`, detailsPath: PATH,
    detect: async d => {
      const w = await d.one<WorkOrder>('select * from pack_work_orders where id = $1', [wo.id])
      // already invoiced or paid: nothing to do (a second DONE never bills twice)
      return w && !['invoiced', 'paid', 'cancelled'].includes(w.status) ? w : null
    },
    describe: w => ({ title: `Job ${w.ref} done: invoice sent`, whatHappened: `The crew marked job ${w.ref} done.`, whatIDid: [`Created the invoice in your accounting system for ${money(w)} and sent it to ${w.customer_name ?? 'the customer'}.`] }),
    act: async (d, w) => {
      await d.query(`update pack_work_orders set status = 'done', done_at = coalesce(done_at, $2) where id = $1`, [w.id, now.toISOString()])
      if (!w.amount || Number(w.amount) <= 0) throw new PackBlocked(`job ${w.ref} has no price, so it cannot be invoiced; add the amount and I will send it`)
      if (!w.customer_email) throw new PackBlocked(`job ${w.ref} has no customer email address for the invoice`)
      const ports = await portsFor(e.orgId)
      const due = isoDay(new Date(now.getTime() + days(org.config.paymentTermsDays)))
      const inv = await ports.invoicing.createInvoice({ customerName: w.customer_name ?? w.customer_email, billEmail: w.customer_email, lines: [{ description: `Job ${w.ref}: ${w.description || 'work completed'}`.slice(0, 300), amount: Number(w.amount) }], dueDate: due, currency: w.currency, idempotencyKey: `${e.orgId}:wo:${w.id}:invoice`, memo: `Deploi job ${w.ref}` })
      const sent = await ports.invoicing.sendInvoice(inv.id)
      await d.query(`update pack_work_orders set status = 'invoiced', invoice_external_id = $2, invoice_number = $3, invoiced_at = $4, invoice_due_date = $5, invoice_balance = $6 where id = $1`, [w.id, inv.id, inv.number, now.toISOString(), inv.dueDate, inv.balance])
      ;(w as WorkOrder & { inv?: string }).inv = inv.id
      return { proof: [rowProof('Invoice', `${inv.number}: ${money(w, inv.total)}, due ${formatDate(inv.dueDate)}`), rowProof('Sent by the accounting system', sent.sent ? 'yes' : 'no')] }
    },
    verify: async (_d, w) => {
      const inv = await (await portsFor(e.orgId)).invoicing.getInvoice((w as WorkOrder & { inv?: string }).inv!)
      const ok = Boolean(inv) && Math.round(inv!.total * 100) === Math.round(Number(w.amount) * 100) && inv!.status !== 'void'
      return { ok, proof: [rowProof('Invoice on a fresh read', inv ? `${inv.number}: total ${money(w, inv.total)}, balance ${money(w, inv.balance)}` : 'not found')] }
    },
  })
}

// ---------------------------------------------------------------- hs_payment_chase and hs_review_request

const officeReceivablesActive = async (db: Db, orgId: string) => Boolean(await db.one(`select 1 from office_agents where org_id = $1 and kind = 'accounts_receivable' and status = 'active' limit 1`, [orgId]))

export async function sweepPayments(db: Db, e: AgentEvent, org: OrgPacks, pack: 'home_services' | 'office' = PACK) {
  const now = eventNow(e)
  const today = isoDay(now)
  const out: PackOutcome[] = []
  const open = await db.query<WorkOrder>(`select * from pack_work_orders where org_id = $1 and pack = $2 and status = 'invoiced' and invoice_external_id is not null order by invoiced_at limit 50`, [e.orgId, pack])
  if (!open.length) return out
  const ports = await portsFor(e.orgId)
  // an Office receivables agent already chases this company's QuickBooks invoices: never send a second reminder
  const officeChases = await officeReceivablesActive(db, e.orgId)
  for (const wo of open) {
    let inv
    try { inv = await ports.invoicing.getInvoice(wo.invoice_external_id!) } catch { continue }
    if (!inv) continue
    if (inv.balance <= 0 || inv.status === 'paid') {
      out.push(await runPackLoop(db, pack, {
        orgId: e.orgId, agentKey: 'hs_payment_chase', agentName: NAME.hs_payment_chase, actionType: 'update_record', problemKey: `wo:${wo.id}:paid`, detailsPath: PATH,
        detect: async () => inv,
        describe: () => ({ title: `Job ${wo.ref} is paid`, whatHappened: `Invoice ${inv.number} (${money(wo, inv.total)}) shows a zero balance in your accounting system.`, whatIDid: ['Marked the job paid and stopped reminders.'] }),
        act: async d => { await d.query(`update pack_work_orders set status = 'paid', paid_at = $2, invoice_balance = 0 where id = $1`, [wo.id, now.toISOString()]); return {} },
        verify: async () => { const f = await ports.invoicing.getInvoice(inv.id); return { ok: Boolean(f && f.balance <= 0), proof: [rowProof('Balance on a fresh read', money(wo, f?.balance ?? null))] } },
      }))
      continue
    }
    if (Math.round(inv.balance * 100) !== Math.round(Number(wo.invoice_balance ?? inv.total) * 100)) await db.query(`update pack_work_orders set invoice_balance = $2 where id = $1`, [wo.id, inv.balance])
    if (officeChases) continue
    const max = org.config.paymentReminderDays.length
    const n = wo.payment_reminders + 1
    const elig = overdueStatus({ id: inv.id, docNumber: inv.number, txnDate: null, dueDate: inv.dueDate, totalAmt: inv.total, balance: inv.balance, currency: inv.currency, customerId: null, customerName: inv.customerName, billEmail: inv.billEmail, privateNote: null, linkedPaymentIds: [], updatedAt: null },
      { overdueDays: org.config.paymentReminderDays[Math.min(n, max) - 1] ?? 3, minBalance: 0, excludeCustomerIds: [] }, today)
    if (!elig.eligible && elig.reason !== 'no_billing_email') continue
    if (n > max) {
      // the owner takes over a week after the last reminder
      if (wo.payment_escalated_at || !wo.last_payment_reminder_at || Date.parse(wo.last_payment_reminder_at) > now.getTime() - days(7)) continue
      out.push(await runPackLoop(db, pack, {
        orgId: e.orgId, agentKey: 'hs_payment_chase', agentName: NAME.hs_payment_chase, actionType: 'notify_owner', problemKey: `wo:${wo.id}:payment:escalate`, detailsPath: PATH,
        detect: async () => inv,
        describe: () => ({ title: `Invoice ${inv.number} still unpaid after ${max} reminders`, whatHappened: `${money(wo, inv.balance)} is still open on job ${wo.ref}, ${elig.daysOverdue} days past due.`, whatIDid: ['Stopped the reminders and handed it to you.'] }),
        act: async d => { await d.query(`update pack_work_orders set payment_escalated_at = $2 where id = $1`, [wo.id, now.toISOString()]); return {} },
        verify: async d => { const r = await d.one<{ payment_escalated_at: string | null }>('select payment_escalated_at from pack_work_orders where id = $1', [wo.id]); return { ok: Boolean(r?.payment_escalated_at), proof: [] } },
      }))
      continue
    }
    out.push(await runPackLoop(db, pack, {
      orgId: e.orgId, agentKey: 'hs_payment_chase', agentName: NAME.hs_payment_chase, actionType: 'send_customer_email', problemKey: `wo:${wo.id}:payment:${n}`, detailsPath: PATH,
      detect: async () => inv,
      describe: () => ({ title: `Payment reminder ${n} of ${max}: invoice ${inv.number}`, whatHappened: `Invoice ${inv.number} is ${elig.daysOverdue} days past due with ${money(wo, inv.balance)} open${inv.balance < inv.total ? ` (part paid: ${money(wo, inv.total - inv.balance)} received)` : ''}.`, whatIDid: [`Sent reminder ${n} of ${max}.`] }),
      act: async (d, p) => {
        const to = inv.billEmail ?? wo.customer_email
        if (!to) throw new PackBlocked(`invoice ${inv.number} has no billing email`)
        const draft = reminderDraft({ docNumber: inv.number, qboInvoiceId: inv.id, customerName: inv.customerName ?? wo.customer_name, currency: inv.currency, totalAmt: inv.total, balance: inv.balance, dueDate: inv.dueDate, txnDate: null }, n, max, org.config.senderName, null)
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_payment_chase', leadId: wo.lead_id, to, ...draft, dedupeKey: `hs:wo:${wo.id}:payment:${n}`, policy: 'general', recipientNames: [inv.customerName, wo.customer_name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the reminder failed the content check' : s.error)
        await d.query(`update pack_work_orders set payment_reminders = $2, last_payment_reminder_at = $3 where id = $1`, [wo.id, n, now.toISOString()])
        ;(p as typeof p & { messageId?: string }).messageId = s.messageId
        return { proof: [policyProof(s.policy), rowProof('Balance read just before sending', money(wo, inv.balance))] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId?: string }).messageId!, 'Reminder'),
    }))
  }
  return out
}

export async function sweepReviews(db: Db, e: AgentEvent, org: OrgPacks, pack: 'home_services' | 'office' = PACK) {
  const now = eventNow(e)
  const paid = await db.query<WorkOrder>(`select * from pack_work_orders where org_id = $1 and pack = $2 and status = 'paid' and review_requested_at is null and paid_at <= $3 order by paid_at limit 50`, [e.orgId, pack, now.toISOString()])
  const out: PackOutcome[] = []
  for (const wo of paid) {
    out.push(await runPackLoop(db, pack, {
      orgId: e.orgId, agentKey: 'hs_review_request', agentName: NAME.hs_review_request, actionType: 'send_customer_email', problemKey: `wo:${wo.id}:review`, detailsPath: PATH,
      detect: async () => wo,
      describe: () => ({ title: `Asked ${wo.customer_name ?? 'the customer'} for a review`, whatHappened: `Job ${wo.ref} is paid.`, whatIDid: ['Sent a thank-you with your review link.'] }),
      act: async (d, p) => {
        if (!org.config.reviewUrl) throw new PackBlocked('add your review link (Google, Yelp ...) in the pack settings and I will send review requests')
        if (!wo.customer_email) throw new PackBlocked(`job ${wo.ref} has no customer email address`)
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'hs_review_request', leadId: wo.lead_id, to: wo.customer_email, ...paymentThanksReview({ name: wo.customer_name, business: org.config.senderName, reviewUrl: org.config.reviewUrl }), dedupeKey: `hs:wo:${wo.id}:review`, policy: 'general', recipientNames: [wo.customer_name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the review request failed the content check' : s.error)
        await d.query(`update pack_work_orders set review_requested_at = $2 where id = $1`, [wo.id, now.toISOString()])
        ;(p as WorkOrder & { messageId?: string }).messageId = s.messageId
        return { proof: [policyProof(s.policy)] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as WorkOrder & { messageId?: string }).messageId!, 'Review request'),
    }))
  }
  return out
}

export async function homeSweep(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  return { leads: await sweepLeadFollowUps(db, e, org, { pack: PACK, agentKey: 'hs_lead_reply', agentName: NAME.hs_lead_reply, fair: false, path: PATH }), quotes: await sweepQuotes(db, e, org), dispatch: await sweepDispatch(db, e, org), payments: await sweepPayments(db, e, org), reviews: await sweepReviews(db, e, org) }
}

/** Undo a quote answer the agent recorded: the quote goes back to how it was (follow-ups resume). */
export async function undoWorkOrderStatus(db: Db, payload: Record<string, unknown>) {
  const st = String(payload.status ?? '')
  if (!['quoted', 'quiet'].includes(st)) return { ok: false, detail: 'nothing to undo' }
  const r = await db.query(`update pack_work_orders set status = $2, status_reason = 'undone by the owner', next_quote_follow_up_at = $3 where id::text = $1 and status in ('accepted','cancelled') returning id`, [String(payload.workOrderId ?? ''), st, payload.nextFollowUpAt ?? null])
  return r.length ? { ok: true, detail: 'the quote is open again' } : { ok: false, detail: 'the job has moved on since; nothing was changed' }
}

export function registerHomeServices() {
  onEvent('lead.email', 'hs_lead_reply', async (db, e) => { await onHomeLead(db, e) })
  onEvent('mail.received', 'hs_quote_booking', async (db, e) => { await onHomeReply(db, e) })
  onEvent('crew.done', 'hs_invoice', async (db, e) => { await onCrewDone(db, e) })
  onEvent('crew.confirmed', 'hs_dispatch', async (db, e) => { await onCrewConfirmed(db, e) })
  onEvent('sweep', 'hs_sweep', async (db, e) => { await homeSweep(db, e) })
  onEvent('quickbooks.payment', 'hs_payment_chase', async (db, e) => { const org = await orgPacks(db, e.orgId); if (org.packs.includes(PACK)) await sweepPayments(db, e, org) })
}
