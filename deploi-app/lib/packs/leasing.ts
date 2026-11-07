/**
 * Leasing and apartment-locating pack. Fair housing is built in, not bolted on:
 *  - every renter is asked the SAME four questions (budget, move-in date, bedrooms, pets) and nothing else;
 *  - only labelled answers are read; the free text of an inquiry (names, languages, anything a person says
 *    about themselves) never changes what is asked, what is shown or what is offered;
 *  - the listings shown are a pure function of the stated criteria (same criteria, same listings, same order);
 *  - every outgoing message passes the fair-housing content check (lib/packs/content-policy.ts) or is not sent.
 *
 * Agents: ls_lead_reply, ls_qualify, ls_tour_booking, ls_tour_reminder, ls_lead_followup (renters);
 *         ls_move_in, ls_commission_invoice, ls_commission_chase, ls_payment_match, ls_weekly_report (commission).
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { onEvent, type AgentEvent } from '../events'
import { formatDate, formatMoney, overdueStatus, reminderDraft } from '../office/receivables'
import { slotLabel } from '../office/slots'
import { newText } from '../office/content'
import { registerPackAgents, type PackAgent, type PackKey } from './registry'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { emailLeadSource, intakeLead, renterCriteria, parseBedrooms, parseDate, parseMoney, parsePets, type LeadRow } from './leads'
import { sendPackMessage, verifySent, policyProof } from './outbound'
import { PortError } from './ports'
import { orgPacks, type OrgPacks } from './settings'
import { bookSlot, openSlots, slotChoice, verifyEvent } from './scheduling'
import { bookingConfirmation, commissionInvoice, leasingReply, missingCriteria, tourReminder, type LeasingCriteria, type ListingView } from './templates'
import { sweepLeadFollowUps } from './lead-followup'
import { invoiceDraftFor, nextInvoiceNumber, recordPayment, weeklyTotals, type InvoiceRow, type PropertyRow } from './commission'
import { addressOf, days, eventNow, hours, isoDay, leadFrom, optedOut, replyText, rowProof, str } from './kit'
import { withInboundText } from '../email/message-text'

const PACK = 'leasing' as const
const PATH = '/store/packs/leasing'
export const LEASING_AGENTS: PackAgent[] = [
  { key: 'ls_lead_reply', name: 'Renter lead responder', pack: PACK, job: 'Replies within minutes to renter leads from Zillow, Apartments.com and Zumper, with the same questions for everyone.', triggers: ['lead.email'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_qualify', name: 'Renter qualifier', pack: PACK, job: 'Reads the answers to the four questions and sends the listings that match them, the same for everyone.', triggers: ['mail.received'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_tour_booking', name: 'Tour booker', pack: PACK, job: 'Books the tour the renter picks on your calendar and confirms it with the application link.', triggers: ['mail.received'], actions: ['book_appointment', 'send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_tour_reminder', name: 'Tour reminder', pack: PACK, job: 'Reminds renters the day before a tour, with the application link.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_lead_followup', name: 'Renter follow-up', pack: PACK, job: 'Follows up renters who went quiet, on the same schedule for everyone.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_move_in', name: 'Move-in tracker', pack: PACK, job: 'Marks each placement moved in on its move-in date, so it can be billed.', triggers: ['sweep'], actions: ['update_record'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_commission_invoice', name: 'Commission invoicer', pack: PACK, job: 'Builds each property\'s commission invoice (tenant, unit, move-in date, commission) and sends it.', triggers: ['sweep'], actions: ['invoice_send'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_commission_chase', name: 'Commission chaser', pack: PACK, job: 'Chases unpaid commission invoices on a schedule, then hands them to you.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_payment_match', name: 'Payment recorder', pack: PACK, job: 'Records commission payments (part or full) and marks invoices paid.', triggers: ['quickbooks.payment'], actions: ['update_record'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ls_weekly_report', name: 'Weekly commission report', pack: PACK, job: 'Emails you what was invoiced, collected and is still owed each week.', triggers: ['sweep'], actions: ['notify_owner'], status: 'synthetic_only', shopifyReady: false },
]
registerPackAgents(LEASING_AGENTS)
const NAME = Object.fromEntries(LEASING_AGENTS.map(a => [a.key, a.name])) as Record<string, string>
const complete = (c: LeasingCriteria) => missingCriteria(c).length === 0
const critHash = (c: LeasingCriteria) => createHash('sha256').update(JSON.stringify([c.budget ?? null, c.moveIn ?? null, c.bedrooms ?? null, c.pets ?? null])).digest('hex').slice(0, 12)

/** The listings for these criteria: a pure function of the four answers. Same criteria, same listings, same order. */
export async function matchListings(db: Db, orgId: string, c: LeasingCriteria): Promise<ListingView[]> {
  if (!complete(c)) return []
  const rows = await db.query<{ unit: string; property: string; bedrooms: number; monthly_rent: string; available_from: string | null; pets_allowed: boolean; application_url: string | null }>(
    `select l.unit, coalesce(p.name, 'Listing') as property, l.bedrooms, l.monthly_rent, to_char(l.available_from, 'YYYY-MM-DD') as available_from, l.pets_allowed, l.application_url
     from leasing_listings l left join leasing_properties p on p.id = l.property_id
     where l.org_id = $1 and l.active and l.bedrooms = $2 and l.monthly_rent <= $3 and (l.available_from is null or l.available_from <= $4::date) and ($5::boolean = false or l.pets_allowed)
     order by l.monthly_rent, coalesce(p.name, ''), l.unit, l.id limit 5`, [orgId, c.bedrooms, c.budget, c.moveIn, c.pets])
  return rows.map(r => ({ unit: r.unit, property: r.property, bedrooms: r.bedrooms, rent: Number(r.monthly_rent), availableFrom: r.available_from, petsAllowed: r.pets_allowed, applicationUrl: r.application_url }))
}

/** Answers in a reply: labelled ("Budget: 2000") or numbered in the order we asked ("1. 2000  2. Dec 1 ..."). */
export function answersIn(text: string, asked: (keyof LeasingCriteria)[], today: string): LeasingCriteria {
  const labelled = renterCriteria(text, today)
  const out: LeasingCriteria = Object.fromEntries(Object.entries(labelled).filter(([, v]) => v !== null && v !== undefined))
  const numbered = [...text.matchAll(/^\s*([1-4])[.)]\s*(.+?)\s*$/gm)]
  for (const m of numbered) {
    const k = asked[Number(m[1]) - 1]
    if (!k || out[k] !== undefined) continue
    const v = k === 'budget' ? parseMoney(m[2]) : k === 'moveIn' ? parseDate(m[2], today) : k === 'bedrooms' ? parseBedrooms(m[2]) : parsePets(m[2])
    if (v !== null) (out as Record<string, unknown>)[k] = v
  }
  return out
}

type ReplyCtx = { messageId?: string; status?: string }
/** Send the reply for a lead's current criteria: the remaining questions, or the matching listings and tour times. */
async function criteriaReply(db: Db, e: AgentEvent, org: OrgPacks, lead: LeadRow, agentKey: 'ls_lead_reply' | 'ls_qualify', pack: PackKey, now: Date) {
  const c = lead.criteria
  return runPackLoop(db, pack, {
    orgId: e.orgId, agentKey, agentName: NAME[agentKey], actionType: 'send_customer_email', problemKey: `lead:${lead.id}:criteria:${critHash(c)}`, detailsPath: PATH,
    detect: async d => {
      const listings = await matchListings(d, e.orgId, c)
      let slots: { start: string; end: string; label: string }[] = []
      if (listings.length) { try { slots = await openSlots(e.orgId, org.config, org.config.tourMinutes, now) } catch { slots = [] } }
      return { listings, slots }
    },
    describe: p => ({
      title: complete(c) ? `Sent ${p.listings.length} matching listing${p.listings.length === 1 ? '' : 's'} to ${lead.name ?? 'a renter'}` : `Asked ${lead.name ?? 'a renter'} the qualifying questions`,
      whatHappened: agentKey === 'ls_lead_reply' ? `A renter lead came in (${lead.source.replace('_', '.')}).` : `${lead.name ?? 'The renter'} answered our questions.`,
      whatIDid: [complete(c) ? `Replied with the listings that match the stated criteria${p.slots.length ? ' and three tour times' : ''}.` : `Asked the ${missingCriteria(c).length} remaining standard question${missingCriteria(c).length === 1 ? '' : 's'}.`, 'The reply passed the fair-housing check.'],
    }),
    act: async (d, p) => {
      if (!lead.email) throw new PackBlocked('the lead has no email address to reply to')
      const draft = leasingReply({ name: lead.name, business: org.config.senderName, criteria: c, listings: p.listings, slots: p.slots, currency: org.config.currency, applicationUrl: p.listings[0]?.applicationUrl ?? org.config.applicationUrl })
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey, leadId: lead.id, to: lead.email, ...draft, dedupeKey: `ls:lead:${lead.id}:criteria:${critHash(c)}`, policy: 'fair_housing', recipientNames: [lead.name] })
      if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? `the reply failed the fair-housing check (${s.policy.violations.map(v => v.term).join(', ')})` : s.error)
      const status = !complete(c) ? 'qualifying' : p.slots.length ? 'slots_offered' : 'replied'
      await d.query(`update pack_leads set status = $2, replied_at = coalesce(replied_at, $3), proposed_slots = $4, next_follow_up_at = $5 where id = $1`,
        [lead.id, status, now.toISOString(), JSON.stringify(p.slots), new Date(now.getTime() + days(org.config.leadFollowUpDays[0] ?? 2)).toISOString()])
      Object.assign(p, { messageId: s.messageId, status })
      return { proof: [policyProof(s.policy), rowProof('Criteria used', JSON.stringify({ budget: c.budget ?? null, moveIn: c.moveIn ?? null, bedrooms: c.bedrooms ?? null, pets: c.pets ?? null })), rowProof('Listings shown', String(p.listings.length))] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & ReplyCtx).messageId!, 'Reply'),
  })
}

export async function onLeasingLead(db: Db, e: AgentEvent, cfg?: OrgPacks): Promise<PackOutcome | null> {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const parsed = emailLeadSource.parse(e.payload)
  if (!parsed) return null
  const { lead, kind } = await intakeLead(db, e.orgId, PACK, parsed, 'renter')
  const now = eventNow(e)
  if (kind === 'repeat') return { status: 'nothing_to_do' }
  if (kind === 'duplicate') {
    // the same renter again: answer on the first lead, only if the answers changed what we would send
    const first = await db.one<LeadRow>('select * from pack_leads where id = $1', [lead.duplicate_of])
    if (!first || !['qualifying', 'replied', 'slots_offered'].includes(first.status)) return { status: 'nothing_to_do' }
    return criteriaReply(db, e, org, first, 'ls_qualify', PACK, now)
  }
  return criteriaReply(db, e, org, lead, 'ls_lead_reply', PACK, now)
}

export async function onLeasingReply(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const from = addressOf(e.payload.from)
  const lead = await leadFrom(db, e.orgId, [PACK], from, ['qualifying', 'replied', 'slots_offered'])
  if (!lead) return null
  const text = replyText(e.payload.subject, e.payload.text)
  const now = eventNow(e)
  if (optedOut(text)) { await db.query(`update pack_leads set status = 'stopped', next_follow_up_at = null where id = $1`, [lead.id]); return { status: 'nothing_to_do' } as const }
  await db.query(`update pack_leads set last_inbound_at = $2, next_follow_up_at = null where id = $1`, [lead.id, now.toISOString()])
  if (lead.status === 'slots_offered' && slotChoice(text)) return bookTour(db, e, org, lead, slotChoice(text)!)
  const asked = missingCriteria(lead.criteria).map(q => q.key)
  const answers = answersIn(newText(String(e.payload.text ?? '')), asked, isoDay(now))
  const merged = { ...lead.criteria, ...answers }
  if (critHash(merged) === critHash(lead.criteria)) return { status: 'nothing_to_do' } as const
  await db.query(`update pack_leads set criteria = $2 where id = $1`, [lead.id, JSON.stringify(merged)])
  return criteriaReply(db, e, org, { ...lead, criteria: merged }, 'ls_qualify', PACK, now)
}

async function bookTour(db: Db, e: AgentEvent, org: OrgPacks, lead: LeadRow, n: number) {
  const slot = lead.proposed_slots[n - 1]
  const appUrl = org.config.applicationUrl
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'ls_tour_booking', agentName: NAME.ls_tour_booking, actionType: 'book_appointment', problemKey: `lead:${lead.id}:tour:${slot?.start ?? n}`, detailsPath: PATH,
    detect: async () => (slot ? { slot } : null),
    describe: p => ({ title: `Tour booked with ${lead.name ?? 'a renter'}`, whatHappened: `${lead.name ?? 'The renter'} picked a tour time (${p.slot.label}).`, whatIDid: ['Booked the tour on your calendar and sent a confirmation with the application link.'] }),
    act: async (d, p) => {
      let eventId: string
      try { eventId = (await bookSlot(d, e.orgId, { leadId: lead.id, kind: 'tour', slot: p.slot, summary: `Tour: ${lead.name ?? lead.email}`, description: `Renter lead ${lead.id}`, attendee: lead.email, timezone: org.config.timezone })).eventId }
      catch (err) {
        if (err instanceof PortError && err.code === 'refused') throw new PackBlocked('the chosen tour time was taken in the meantime; I will offer new times on the next reply')
        throw err
      }
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'ls_tour_booking', leadId: lead.id, to: lead.email!, ...bookingConfirmation({ name: lead.name, business: org.config.senderName, what: 'an apartment tour', slot: p.slot, extra: appUrl ? `You can apply online at any time: ${appUrl}\n\nWe ask every renter the same questions and apply the same written criteria to every application.` : 'We ask every renter the same questions and apply the same written criteria to every application.' }), dedupeKey: `ls:lead:${lead.id}:tour`, policy: 'fair_housing', recipientNames: [lead.name] })
      if (s.status !== 'sent') throw new PackBlocked('the tour is booked but the confirmation could not be sent')
      await d.query(`update pack_leads set status = 'booked', next_follow_up_at = null where id = $1`, [lead.id])
      Object.assign(p, { eventId, messageId: s.messageId })
      return { proof: [policyProof(s.policy)] }
    },
    verify: async (_d, p) => {
      const x = p as typeof p & { eventId: string; messageId: string }
      const ev = await verifyEvent(e.orgId, x.eventId, p.slot.start)
      const m = await verifySent(e.orgId, x.messageId, 'Confirmation')
      return { ok: ev.ok && m.ok, proof: [...ev.proof, ...m.proof] }
    },
  })
}

// ---------------------------------------------------------------- sweeps

export async function sweepTourReminders(db: Db, e: AgentEvent, org: OrgPacks, kind: 'tour' | 'showing' = 'tour', pack: PackKey = PACK, agentKey = 'ls_tour_reminder', agentName = NAME.ls_tour_reminder) {
  const now = eventNow(e)
  const due = await db.query<{ id: string; lead_id: string; starts_at: string }>(`select a.id, a.lead_id, a.starts_at from pack_appointments a join pack_leads l on l.id = a.lead_id
    where a.org_id = $1 and a.kind = $2 and l.pack = $3 and a.status = 'booked' and a.reminder_sent_at is null and a.starts_at > $4 and a.starts_at <= $5 order by a.starts_at limit 50`,
    [e.orgId, kind, pack, now.toISOString(), new Date(now.getTime() + hours(26)).toISOString()])
  const out: PackOutcome[] = []
  for (const a of due) {
    const lead = (await db.one<LeadRow>('select * from pack_leads where id = $1', [a.lead_id]))!
    const when = slotLabel(new Date(a.starts_at).toISOString(), org.config.timezone)
    out.push(await runPackLoop(db, pack, {
      orgId: e.orgId, agentKey, agentName, actionType: 'send_customer_email', problemKey: `appt:${a.id}:reminder`, detailsPath: `/store/packs/${pack}`,
      detect: async () => a,
      describe: () => ({ title: `Reminded ${lead.name ?? 'a renter'} about the ${kind}`, whatHappened: `A ${kind} is booked for ${when}.`, whatIDid: [`Sent a reminder${org.config.applicationUrl && kind === 'tour' ? ' with the application link' : ''}.`] }),
      act: async (d, p) => {
        if (!lead.email) throw new PackBlocked('the lead has no email address')
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey, leadId: lead.id, to: lead.email, ...tourReminder({ name: lead.name, business: org.config.senderName, when, applicationUrl: kind === 'tour' ? org.config.applicationUrl : null }), dedupeKey: `${pack}:appt:${a.id}:reminder`, policy: 'fair_housing', recipientNames: [lead.name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the reminder failed the fair-housing check' : s.error)
        await d.query(`update pack_appointments set reminder_sent_at = $2 where id = $1`, [a.id, now.toISOString()])
        Object.assign(p, { messageId: s.messageId })
        return { proof: [policyProof(s.policy)] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Reminder'),
    }))
  }
  return out
}

export async function sweepMoveIns(db: Db, e: AgentEvent) {
  const today = isoDay(eventNow(e))
  const due = await db.query<{ id: string; tenant_name: string; unit: string; move_in_date: string; property: string | null }>(`select pl.id, pl.tenant_name, pl.unit, to_char(pl.move_in_date, 'YYYY-MM-DD') as move_in_date, p.name as property
    from leasing_placements pl left join leasing_properties p on p.id = pl.property_id where pl.org_id = $1 and pl.status = 'pending' and pl.move_in_date <= $2::date order by pl.move_in_date limit 100`, [e.orgId, today])
  const out: PackOutcome[] = []
  for (const pl of due) {
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'ls_move_in', agentName: NAME.ls_move_in, actionType: 'update_record', problemKey: `placement:${pl.id}:moved_in`, detailsPath: PATH,
      detect: async () => pl,
      describe: () => ({ title: `${pl.tenant_name} moved in at ${pl.property ?? 'the property'}, unit ${pl.unit}`, whatHappened: `The move-in date (${formatDate(pl.move_in_date)}) has arrived.`, whatIDid: ['Marked the placement moved in; it goes on the property\'s next commission invoice.'] }),
      act: async d => { await d.query(`update leasing_placements set status = 'moved_in' where id = $1 and status = 'pending'`, [pl.id]); return {} },
      verify: async d => { const r = await d.one<{ status: string }>('select status from leasing_placements where id = $1', [pl.id]); return { ok: r?.status === 'moved_in', proof: [rowProof('Placement status now', r?.status ?? 'missing')] } },
    }))
  }
  return out
}

export async function sweepCommissionInvoices(db: Db, e: AgentEvent, org: OrgPacks) {
  const now = eventNow(e)
  const today = isoDay(now)
  const props = await db.query<PropertyRow & { company_email: string | null; contact_name: string | null }>(`select p.*, c.billing_email as company_email, c.contact_name from leasing_properties p left join leasing_companies c on c.id = p.company_id
    where p.org_id = $1 and exists (select 1 from leasing_placements x where x.property_id = p.id and x.status = 'moved_in' and x.invoice_id is null) order by p.name`, [e.orgId])
  const out: PackOutcome[] = []
  for (const prop of props) {
    const draft = await invoiceDraftFor(db, e.orgId, prop.id)
    if (!draft.placements.length) continue
    const batch = createHash('sha256').update(draft.placements.map(p => p.id).join(',')).digest('hex').slice(0, 12)
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'ls_commission_invoice', agentName: NAME.ls_commission_invoice, actionType: 'invoice_send', problemKey: `property:${prop.id}:invoice:${batch}`, detailsPath: PATH,
      detect: async () => draft,
      describe: p => ({ title: `Commission invoice sent to ${prop.name}`, whatHappened: `${p.placements.length} move-in${p.placements.length === 1 ? '' : 's'} at ${prop.name} not yet billed.`, whatIDid: [`Built the invoice (${formatMoney(p.totalCents / 100, org.config.currency)}: ${p.lines.map(l => `${l.tenant}, unit ${l.unit}`).join('; ')}) and emailed it.`] }),
      act: async (d, p) => {
        const to = prop.billing_email ?? prop.company_email
        if (!to) throw new PackBlocked(`${prop.name} has no billing email (on the property or its managing company)`)
        if (p.totalCents <= 0) throw new PackBlocked(`the commission for ${prop.name} comes to zero; check the property's commission rule`)
        const number = await nextInvoiceNumber(d, e.orgId)
        const due = isoDay(new Date(now.getTime() + days(prop.payment_terms_days)))
        const inv = (await d.one<InvoiceRow>(`insert into leasing_invoices (org_id, property_id, number, issued_on, due_date, currency, total, status, bill_to, lines) values ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9) returning *`,
          [e.orgId, prop.id, number, today, due, org.config.currency, p.totalCents / 100, to, JSON.stringify(p.lines)]))!
        await d.query(`update leasing_placements set invoice_id = $2, status = 'invoiced' where id = any($1::uuid[])`, [p.placements.map(x => x.id), inv.id])
        const mail = commissionInvoice({ business: org.config.senderName, property: prop.name, contact: prop.contact_name, number, issued: today, due, lines: p.lines, total: p.totalCents / 100, currency: org.config.currency })
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'ls_commission_invoice', to, ...mail, dedupeKey: `ls:invoice:${prop.id}:${batch}`, policy: 'general', recipientNames: [prop.contact_name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the invoice email failed the content check' : s.error)
        await d.query(`update leasing_invoices set status = 'sent', sent_at = $2 where id = $1`, [inv.id, now.toISOString()])
        Object.assign(p, { invoiceId: inv.id, messageId: s.messageId })
        return { proof: [rowProof('Invoice', `${number}: ${formatMoney(p.totalCents / 100, org.config.currency)}, due ${formatDate(due)}`), rowProof('Sent to', to)] }
      },
      verify: async (d, p) => {
        const x = p as typeof p & { invoiceId: string; messageId: string }
        const inv = await d.one<{ total: string; status: string; n: number; sum: string }>(`select i.total, i.status, (select count(*)::int from leasing_placements where invoice_id = i.id) as n,
            (select coalesce(sum(commission_amount), 0) from leasing_placements where invoice_id = i.id) as sum from leasing_invoices i where i.id = $1`, [x.invoiceId])
        const m = await verifySent(e.orgId, x.messageId, 'Invoice email')
        const ok = Boolean(inv) && inv!.status === 'sent' && Math.round(Number(inv!.total) * 100) === p.totalCents && Math.round(Number(inv!.sum) * 100) === p.totalCents && inv!.n === p.placements.length
        return { ok: ok && m.ok, proof: [rowProof('Invoice total equals its move-ins', inv ? `${inv.total} = ${inv.sum} over ${inv.n} placement(s)` : 'invoice missing'), ...m.proof] }
      },
    }))
  }
  return out
}

export async function sweepCommissionChase(db: Db, e: AgentEvent, org: OrgPacks) {
  const now = eventNow(e)
  const today = isoDay(now)
  const max = org.config.paymentReminderDays.length
  const open = await db.query<InvoiceRow & { property: string | null }>(`select i.*, to_char(i.due_date, 'YYYY-MM-DD') as due_date, to_char(i.issued_on, 'YYYY-MM-DD') as issued_on, p.name as property from leasing_invoices i
    left join leasing_properties p on p.id = i.property_id where i.org_id = $1 and i.status in ('sent','partial') and i.due_date < $2::date and i.escalated_at is null order by i.due_date limit 50`, [e.orgId, today])
  const out: PackOutcome[] = []
  for (const inv of open) {
    const balance = (Math.round(Number(inv.total) * 100) - Math.round(Number(inv.paid_amount) * 100)) / 100
    const n = inv.reminders + 1
    if (n > max) {
      if (!inv.last_reminder_at || Date.parse(inv.last_reminder_at) > now.getTime() - days(7)) continue
      out.push(await runPackLoop(db, PACK, {
        orgId: e.orgId, agentKey: 'ls_commission_chase', agentName: NAME.ls_commission_chase, actionType: 'notify_owner', problemKey: `invoice:${inv.id}:escalate`, detailsPath: PATH,
        detect: async () => inv,
        describe: () => ({ title: `Invoice ${inv.number} unpaid after ${max} reminders`, whatHappened: `${formatMoney(balance, inv.currency)} is still owed by ${inv.property ?? 'the property'}.`, whatIDid: ['Stopped the reminders and handed it to you.'] }),
        act: async d => { await d.query(`update leasing_invoices set escalated_at = $2 where id = $1`, [inv.id, now.toISOString()]); return {} },
        verify: async d => { const r = await d.one<{ escalated_at: string | null }>('select escalated_at from leasing_invoices where id = $1', [inv.id]); return { ok: Boolean(r?.escalated_at), proof: [] } },
      }))
      continue
    }
    const elig = overdueStatus({ id: inv.id, docNumber: inv.number, txnDate: inv.issued_on, dueDate: inv.due_date, totalAmt: Number(inv.total), balance, currency: inv.currency, customerId: null, customerName: inv.property, billEmail: inv.bill_to, privateNote: null, linkedPaymentIds: [], updatedAt: null },
      { overdueDays: org.config.paymentReminderDays[n - 1], minBalance: 0, excludeCustomerIds: [] }, today)
    if (!elig.eligible) continue
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'ls_commission_chase', agentName: NAME.ls_commission_chase, actionType: 'send_customer_email', problemKey: `invoice:${inv.id}:reminder:${n}`, detailsPath: PATH,
      detect: async () => inv,
      describe: () => ({ title: `Reminder ${n} of ${max}: invoice ${inv.number}`, whatHappened: `Invoice ${inv.number} to ${inv.property ?? 'the property'} is ${elig.daysOverdue} days past due with ${formatMoney(balance, inv.currency)} open.`, whatIDid: [`Sent reminder ${n} of ${max} to ${inv.bill_to}.`] }),
      act: async (d, p) => {
        const draft = reminderDraft({ docNumber: inv.number, qboInvoiceId: inv.id, customerName: inv.property, currency: inv.currency, totalAmt: inv.total, balance, dueDate: inv.due_date, txnDate: inv.issued_on }, n, max, org.config.senderName, null)
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'ls_commission_chase', to: inv.bill_to!, ...draft, dedupeKey: `ls:invoice:${inv.id}:reminder:${n}`, policy: 'general' })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the reminder failed the content check' : s.error)
        await d.query(`update leasing_invoices set reminders = $2, last_reminder_at = $3 where id = $1`, [inv.id, n, now.toISOString()])
        Object.assign(p, { messageId: s.messageId })
        return { proof: [policyProof(s.policy), rowProof('Open balance', formatMoney(balance, inv.currency))] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Reminder'),
    }))
  }
  return out
}

/** A payment notice (QuickBooks, or the owner): { invoiceNumber, amount, receivedOn?, paymentId? }. */
export async function onCommissionPayment(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const number = str(e.payload.invoiceNumber, 40)
  const amount = Number(e.payload.amount)
  if (!number || !(amount > 0)) return null
  const inv = await db.one<InvoiceRow>('select * from leasing_invoices where org_id = $1 and number = $2', [e.orgId, number])
  if (!inv) return null
  const receivedOn = str(e.payload.receivedOn, 10) ?? isoDay(eventNow(e))
  const ext = str(e.payload.paymentId, 120) ?? e.externalId
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'ls_payment_match', agentName: NAME.ls_payment_match, actionType: 'update_record', problemKey: `payment:${ext}`, detailsPath: PATH,
    detect: async () => inv,
    describe: () => ({ title: `Payment of ${formatMoney(amount, inv.currency)} recorded on invoice ${inv.number}`, whatHappened: `A payment of ${formatMoney(amount, inv.currency)} came in for invoice ${inv.number}.`, whatIDid: ['Recorded it against the invoice.'] }),
    act: async (d, p) => {
      const r = await recordPayment(d, e.orgId, { invoiceId: inv.id, amount, receivedOn, externalId: ext })
      Object.assign(p, { result: r })
      return { undo: r.paymentId ? { kind: 'leasing_payment', payload: { paymentId: r.paymentId } } : null, proof: [rowProof('Invoice status now', `${r.invoice.status}: ${formatMoney(r.invoice.paid_amount, inv.currency)} of ${formatMoney(r.invoice.total, inv.currency)} paid`), ...(r.overpaid > 0 ? [rowProof('Paid more than was owed', formatMoney(r.overpaid, inv.currency))] : [])] }
    },
    verify: async d => {
      const r = await d.one<{ status: string; paid_amount: string; total: string; sum: string }>(`select status, paid_amount, total, (select coalesce(sum(amount), 0) from leasing_payments where invoice_id = i.id) as sum from leasing_invoices i where id = $1`, [inv.id])
      const ok = Boolean(r) && Math.round(Number(r!.paid_amount) * 100) === Math.round(Number(r!.sum) * 100) && (r!.status === 'paid') === (Number(r!.paid_amount) >= Number(r!.total))
      return { ok, proof: [rowProof('Payments on the invoice add up', r ? `${r.sum} recorded, status ${r.status}` : 'missing')] }
    },
  })
}

export async function sweepWeeklyReport(db: Db, e: AgentEvent, org: OrgPacks) {
  const now = eventNow(e)
  const weekday = ((now.getUTCDay() + 6) % 7) + 1
  if (weekday !== org.config.weeklyReportDay) return null
  const to = isoDay(now), from = isoDay(new Date(now.getTime() - days(7)))
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'ls_weekly_report', agentName: NAME.ls_weekly_report, actionType: 'notify_owner', problemKey: `week:${from}`, detailsPath: PATH,
    detect: async d => weeklyTotals(d, e.orgId, from, to),
    describe: t => ({
      title: `Commission week: ${formatMoney(t.invoiced, org.config.currency)} invoiced, ${formatMoney(t.collected, org.config.currency)} collected, ${formatMoney(t.owed, org.config.currency)} owed`,
      whatHappened: `Your commission summary for ${formatDate(from)} to ${formatDate(isoDay(new Date(now.getTime() - days(1))))}.`,
      whatIDid: [`Invoiced ${formatMoney(t.invoiced, org.config.currency)} on ${t.invoices} invoice${t.invoices === 1 ? '' : 's'}.`, `Collected ${formatMoney(t.collected, org.config.currency)} in ${t.payments} payment${t.payments === 1 ? '' : 's'}.`,
        `Still owed: ${formatMoney(t.owed, org.config.currency)}${t.overdue ? `, of which ${formatMoney(t.overdue, org.config.currency)} is past due` : ''}.`],
    }),
    act: async (_d, t) => ({ proof: [rowProof('Invoiced', String(t.invoiced)), rowProof('Collected', String(t.collected)), rowProof('Owed', String(t.owed))] }),
    verify: async (d, t) => {
      const again = await weeklyTotals(d, e.orgId, from, to)
      const ok = again.invoiced === t.invoiced && again.collected === t.collected && again.owed === t.owed
      return { ok, proof: [rowProof('Totals re-read from the records', ok ? 'match' : 'changed while reporting')] }
    },
  })
}

export async function leasingSweep(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  return {
    followUps: await sweepLeadFollowUps(db, e, org, { pack: PACK, agentKey: 'ls_lead_followup', agentName: NAME.ls_lead_followup, fair: true, path: PATH }),
    reminders: await sweepTourReminders(db, e, org),
    moveIns: await sweepMoveIns(db, e),
    invoices: await sweepCommissionInvoices(db, e, org),
    chase: await sweepCommissionChase(db, e, org),
    weekly: await sweepWeeklyReport(db, e, org),
  }
}

export function registerLeasing() {
  onEvent('lead.email', 'ls_lead_reply', async (db, e) => { await onLeasingLead(db, e) })
  onEvent('mail.received', 'ls_qualify', async (db, e) => { const m = await withInboundText(db, e); if (m) await onLeasingReply(db, m) })
  onEvent('quickbooks.payment', 'ls_payment_match', async (db, e) => { await onCommissionPayment(db, e) })
  onEvent('sweep', 'ls_sweep', async (db, e) => { await leasingSweep(db, e) })
}
