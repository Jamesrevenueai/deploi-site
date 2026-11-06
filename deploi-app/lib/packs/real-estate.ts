/**
 * Real estate agents pack. Fair housing applies here too: every buyer is asked the same questions, every
 * outgoing message passes the fair-housing check, and nothing in a lead's free text is used.
 *   re_lead_reply   instant reply to buyer and seller leads, with showing / valuation times
 *   re_showing      the lead's "2" books the showing (or the seller visit) and confirms it
 *   re_followup     quiet leads are followed up on the same cadence for everyone
 *   re_crm_update   every lead and booking is written to the CRM (contact, stage, note) through the CrmPort
 */
import type { Db } from '../db'
import { onEvent, type AgentEvent } from '../events'
import { registerPackAgents, type PackAgent } from './registry'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { crmLeadSource, emailLeadSource, intakeLead, type LeadRow } from './leads'
import { sendPackMessage, verifySent, policyProof } from './outbound'
import { PortError, portsFor } from './ports'
import { orgPacks, type OrgPacks } from './settings'
import { bookSlot, openSlots, slotChoice, verifyEvent } from './scheduling'
import { bookingConfirmation, buyerReply, sellerReply } from './templates'
import { sweepLeadFollowUps } from './lead-followup'
import { sweepTourReminders } from './leasing'
import { addressOf, eventNow, days, leadFrom, optedOut, replyText, rowProof } from './kit'
import { withInboundText } from '../email/message-text'

const PACK = 'real_estate' as const
const PATH = '/store/packs/real_estate'
export const REAL_ESTATE_AGENTS: PackAgent[] = [
  { key: 're_lead_reply', name: 'Buyer and seller responder', pack: PACK, job: 'Replies within minutes to buyer and seller leads, with times to see a home or meet.', triggers: ['lead.email', 'crm.lead.created'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 're_showing', name: 'Showing booker', pack: PACK, job: 'Books the showing or listing visit the lead picks and confirms it.', triggers: ['mail.received'], actions: ['book_appointment', 'send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 're_followup', name: 'Lead follow-up', pack: PACK, job: 'Follows up leads that went quiet, on the same schedule for everyone, and reminds them of showings.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 're_crm_update', name: 'CRM updater', pack: PACK, job: 'Keeps your CRM current: every lead, reply and showing is logged on the contact.', triggers: ['lead.email', 'mail.received'], actions: ['update_crm'], status: 'synthetic_only', shopifyReady: false },
]
registerPackAgents(REAL_ESTATE_AGENTS)
const NAME = Object.fromEntries(REAL_ESTATE_AGENTS.map(a => [a.key, a.name])) as Record<string, string>

/** Write one step to the CRM: the contact (stage) and a note; verified by reading the contact back. */
export async function crmLog(db: Db, orgId: string, lead: LeadRow, step: { stage: string; note: string; key: string }) {
  return runPackLoop(db, PACK, {
    orgId, agentKey: 're_crm_update', agentName: NAME.re_crm_update, actionType: 'update_crm', problemKey: `lead:${lead.id}:crm:${step.key}`, detailsPath: PATH,
    detect: async () => (lead.email ? lead : null),
    describe: () => ({ title: `CRM updated for ${lead.name ?? lead.email}`, whatHappened: step.note, whatIDid: [`Set the contact's stage to "${step.stage}" and logged a note.`] }),
    act: async (d, p) => {
      const crm = (await portsFor(orgId)).crm
      const c = await crm.upsertContact({ email: lead.email!, name: lead.name, phone: lead.phone, stage: step.stage, tags: [lead.intent, lead.source] })
      await crm.setStage(c.id, step.stage)
      await crm.addNote(c.id, step.note, `${orgId}:${lead.id}:${step.key}`)
      await d.query(`update pack_leads set crm_record_id = $2 where id = $1`, [lead.id, c.id])
      Object.assign(p, { contactId: c.id })
      return { proof: [rowProof('CRM contact', `${crm.provider} ${c.id}`)] }
    },
    verify: async (_d, p) => {
      const c = await (await portsFor(orgId)).crm.getContact((p as LeadRow & { contactId: string }).contactId)
      const ok = Boolean(c) && c!.stage === step.stage && c!.notes.includes(step.note)
      return { ok, proof: [rowProof('CRM contact on a fresh read', c ? `stage ${c.stage}, ${c.notes.length} note(s)` : 'not found')] }
    },
  })
}

export async function onRealEstateLead(db: Db, e: AgentEvent, cfg?: OrgPacks): Promise<PackOutcome[] | null> {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const parsed = (e.type.startsWith('crm.') ? crmLeadSource : emailLeadSource).parse(e.payload)
  if (!parsed) return null
  const intent = parsed.intent === 'seller' ? 'seller' : 'buyer'
  const { lead, kind } = await intakeLead(db, e.orgId, PACK, parsed, intent)
  if (kind !== 'new') return []
  const now = eventNow(e)
  const out: PackOutcome[] = []
  out.push(await runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 're_lead_reply', agentName: NAME.re_lead_reply, actionType: 'send_customer_email', problemKey: `lead:${lead.id}:reply`, detailsPath: PATH,
    detect: async () => {
      let slots: { start: string; end: string; label: string }[] = []
      try { slots = await openSlots(e.orgId, org.config, org.config.showingMinutes, now) } catch { slots = [] }
      return { slots }
    },
    describe: p => ({ title: `New ${intent} lead${lead.name ? ` from ${lead.name}` : ''}: replied`, whatHappened: `A ${intent} lead came in (${lead.source.replace('_', '.')}).`, whatIDid: [`Replied with the standard ${intent} questions${p.slots.length ? ' and three times to meet' : ''}.`, 'The reply passed the fair-housing check.'] }),
    act: async (d, p) => {
      if (!lead.email) throw new PackBlocked('the lead gave no email address; call them on the number in the lead')
      const draft = intent === 'seller' ? sellerReply({ name: lead.name, business: org.config.senderName, slots: p.slots }) : buyerReply({ name: lead.name, business: org.config.senderName, slots: p.slots })
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 're_lead_reply', leadId: lead.id, to: lead.email, ...draft, dedupeKey: `re:lead:${lead.id}:reply`, policy: 'fair_housing', recipientNames: [lead.name] })
      if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the reply failed the fair-housing check' : s.error)
      await d.query(`update pack_leads set status = $2, replied_at = $3, proposed_slots = $4, next_follow_up_at = $5 where id = $1`, [lead.id, p.slots.length ? 'slots_offered' : 'replied', now.toISOString(), JSON.stringify(p.slots), new Date(now.getTime() + days(org.config.leadFollowUpDays[0] ?? 2)).toISOString()])
      Object.assign(p, { messageId: s.messageId })
      return { proof: [policyProof(s.policy)] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Reply'),
  }))
  out.push(await crmLog(db, e.orgId, lead, { stage: 'new lead', note: `New ${intent} lead from ${lead.source.replace('_', '.')}; replied automatically.`, key: 'new' }))
  return out
}

export async function onRealEstateReply(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const lead = await leadFrom(db, e.orgId, [PACK], addressOf(e.payload.from), ['replied', 'slots_offered'])
  if (!lead) return null
  const text = replyText(e.payload.subject, e.payload.text)
  const now = eventNow(e)
  if (optedOut(text)) { await db.query(`update pack_leads set status = 'stopped', next_follow_up_at = null where id = $1`, [lead.id]); return [await crmLog(db, e.orgId, lead, { stage: 'do not contact', note: 'Asked us to stop emailing.', key: 'optout' })] }
  await db.query(`update pack_leads set last_inbound_at = $2, next_follow_up_at = null where id = $1`, [lead.id, now.toISOString()])
  const n = lead.status === 'slots_offered' ? slotChoice(text) : null
  const slot = n ? lead.proposed_slots[n - 1] : null
  if (!slot) return [await crmLog(db, e.orgId, lead, { stage: 'engaged', note: 'Replied to our message (the reply is in your inbox).', key: `reply:${e.externalId}` })]
  const what = lead.intent === 'seller' ? 'a listing visit' : 'a showing'
  const out: PackOutcome[] = [await runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 're_showing', agentName: NAME.re_showing, actionType: 'book_appointment', problemKey: `lead:${lead.id}:showing:${slot.start}`, detailsPath: PATH,
    detect: async () => ({ slot }),
    describe: () => ({ title: `${lead.intent === 'seller' ? 'Listing visit' : 'Showing'} booked with ${lead.name ?? lead.email}`, whatHappened: `${lead.name ?? 'The lead'} picked ${slot.label}.`, whatIDid: ['Booked it on your calendar and sent a confirmation.'] }),
    act: async (d, p) => {
      let eventId: string
      try { eventId = (await bookSlot(d, e.orgId, { leadId: lead.id, kind: 'showing', slot, summary: `${lead.intent === 'seller' ? 'Listing visit' : 'Showing'}: ${lead.name ?? lead.email}`, description: `Lead ${lead.id}`, attendee: lead.email, timezone: org.config.timezone })).eventId }
      catch (err) { if (err instanceof PortError && err.code === 'refused') throw new PackBlocked('that time was taken in the meantime; please offer new times'); throw err }
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 're_showing', leadId: lead.id, to: lead.email!, ...bookingConfirmation({ name: lead.name, business: org.config.senderName, what, slot }), dedupeKey: `re:lead:${lead.id}:showing`, policy: 'fair_housing', recipientNames: [lead.name] })
      if (s.status !== 'sent') throw new PackBlocked('booked, but the confirmation could not be sent')
      await d.query(`update pack_leads set status = 'booked' where id = $1`, [lead.id])
      Object.assign(p, { eventId, messageId: s.messageId })
      return { proof: [policyProof(s.policy)] }
    },
    verify: async (_d, p) => {
      const x = p as typeof p & { eventId: string; messageId: string }
      const ev = await verifyEvent(e.orgId, x.eventId, slot.start), m = await verifySent(e.orgId, x.messageId, 'Confirmation')
      return { ok: ev.ok && m.ok, proof: [...ev.proof, ...m.proof] }
    },
  })]
  if (out[0].status === 'done') out.push(await crmLog(db, e.orgId, lead, { stage: lead.intent === 'seller' ? 'appointment set' : 'showing booked', note: `Booked ${what}: ${slot.label}.`, key: `booked:${slot.start}` }))
  return out
}

export async function realEstateSweep(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  return {
    followUps: await sweepLeadFollowUps(db, e, org, { pack: PACK, agentKey: 're_followup', agentName: NAME.re_followup, fair: true, path: PATH }),
    reminders: await sweepTourReminders(db, e, org, 'showing', PACK, 're_followup', NAME.re_followup),
  }
}

export function registerRealEstate() {
  onEvent('lead.email', 're_lead_reply', async (db, e) => { await onRealEstateLead(db, e) })
  onEvent('crm.lead.created', 're_lead_reply', async (db, e) => { await onRealEstateLead(db, e) })
  onEvent('mail.received', 're_showing', async (db, e) => { const m = await withInboundText(db, e); if (m) await onRealEstateReply(db, m) })
  onEvent('sweep', 're_sweep', async (db, e) => { await realEstateSweep(db, e) })
}
