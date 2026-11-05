/**
 * Office agent runs. Each run reads (HubSpot leads, free/busy, incoming replies) and PROPOSES actions;
 * whether an action is a draft, waits for approval or goes ahead is decided by lib/office/actions.ts from
 * the granted policy alone. Incoming mail is reduced to a category: its text never adds a recipient or
 * changes a permission. Every run is recorded in office_runs and the audit trail.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { decryptSecret } from '../connectors/credentials'
import { emailAdapter } from '../email/adapters'
import { accessToken, accountRef, type EmailAccountRow } from '../email/accounts'
import { officeAudit } from './audit'
import { officeConfig } from './config'
import { OfficeHttpError } from './http'
import { OfficeAuthError } from './credentials'
import { calendarFor, hubspotFor } from './providers'
import type { OfficeConnectionRow } from './connections'
import { agentCtx, executeOfficeAction, proposeAction, sha, stopLead, type AgentCtx, type EmailPayload, type OfficeActionRow } from './actions'
import { classifyInbound, crmMarker, customerReplyDraft, firstTouch, followUp, meetingProposal, type InboundCategory } from './content'
import { proposeSlots, type Slot } from './slots'
import { eventIdFor } from './calendar'
import type { OfficePolicy } from './policy'
import { ReceivablesBlocked, runReceivables, syncReceivables } from './receivables'
import { classifyLeadReply, handedLeadCases, proposeCaseCrmNotes, syncOfficeCases } from './resolution'
import { emailOperationsRun } from './email-ops'
import { officeBlockReason } from '../integrations/blocking'

export type LeadRow = { id: string; org_id: string; agent_id: string; hubspot_contact_id: string; email: string; first_name: string | null; company: string | null; lifecycle_stage: string | null; status: string; touches: number; next_touch_at: string | null; thread_message_id: string | null; replied_at: string | null; stop_reason: string | null }
export type MeetingRow = { id: string; org_id: string; agent_id: string; lead_id: string | null; contact_email: string; hubspot_contact_id: string | null; status: string; proposed_slots: Slot[]; chosen_slot: Slot | null; proposal_message_id: string | null; calendar_event_id: string | null; source_inbound_id: string | null }
type Counts = Record<string, number>
const isEmail = (a: string) => /^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(a)

async function conn(db: Db, orgId: string, id: string | null): Promise<OfficeConnectionRow | null> {
  if (!id) return null
  return db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2 and status = 'active'`, [id, orgId])
}

class Blocked extends Error { constructor(m: string) { super(m); this.name = 'Blocked' } }

// ---------------------------------------------------------------- Lead Follow-up

async function proposeTouch(ctx: AgentCtx, lead: LeadRow, touch: number, firstSubject: string | null, now: Date) {
  const l = ctx.policy!.leadFollowup!
  const d = touch === 1 ? firstTouch({ firstName: lead.first_name, company: lead.company }, l.senderName, l.pitch) : followUp({ firstName: lead.first_name }, l.senderName, firstSubject ?? 'my note', touch)
  return admin(db => proposeAction(db, {
    agentId: ctx.agent.id, kind: 'send_email', purpose: touch === 1 ? 'First email to a new lead' : `Follow-up ${touch - 1} to a lead`, idempotencyKey: `lead:${ctx.agent.id}:${lead.hubspot_contact_id}:touch:${touch}`, leadId: lead.id, now,
    payload: { type: 'email', to: lead.email, subject: d.subject, body: d.body, inReplyToMessageId: touch === 1 ? null : lead.thread_message_id, recipientSource: { kind: 'lead', leadId: lead.id }, meta: { touch, subject: d.subject } },
  }))
}

async function pollLeads(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!
  const hc = await admin(db => conn(db, ctx.agent.org_id, p.hubspotConnectionId))
  if (!hc) throw new Blocked(await officeBlockReason(ctx.agent.org_id, p.hubspotConnectionId, 'HubSpot'))
  const hs = hubspotFor(hc)
  // overlap the previous poll by five minutes; HubSpot's search index can lag a little behind writes
  const since = ctx.agent.last_polled_at ? new Date(new Date(ctx.agent.last_polled_at).getTime() - 5 * 60e3) : new Date(now.getTime() - p.leadFollowup!.lookbackDays * 864e5)
  let after: string | null = null
  for (let page = 0; page < officeConfig.pollPages; page++) {
    const r = await hs.searchLeads({ since, after, limit: officeConfig.leadsPerPoll })
    for (const c of r.contacts) {
      counts.leads_seen = (counts.leads_seen ?? 0) + 1
      if (!c.email || !isEmail(c.email) || c.optedOut || c.lifecycleStage !== 'lead') continue
      const lead = await admin(db => db.one<LeadRow>(`insert into office_leads (org_id, agent_id, hubspot_contact_id, email, first_name, company, lifecycle_stage) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (agent_id, hubspot_contact_id) do nothing returning *`, [ctx.agent.org_id, ctx.agent.id, c.id, c.email, c.firstName?.slice(0, 80) ?? null, c.company?.slice(0, 120) ?? null, c.lifecycleStage]))
      if (!lead) continue
      counts.leads_new = (counts.leads_new ?? 0) + 1
      await proposeTouch(ctx, lead, 1, null, now)
      counts.proposed = (counts.proposed ?? 0) + 1
    }
    after = r.next
    if (!after) break
  }
  await admin(db => db.query('update office_agents set last_polled_at = $2 where id = $1', [ctx.agent.id, now.toISOString()]))
}

/** Replies noticed by the provider (connected accounts with read access); agent mailboxes learn of replies from the inbound webhook. */
async function checkReplies(ctx: AgentCtx, counts: Counts) {
  const p = ctx.policy!
  if (!p.mailboxAccountId) return
  const account = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [p.mailboxAccountId]))
  if (!account || account.provider === 'deploi' || account.status !== 'active' || !account.can_read) return
  const msgs = await admin(db => db.query<{ id: string; internet_message_id: string; provider_thread_id: string | null; reply_count: number; to_addresses: string[] }>(`select m.id, m.internet_message_id, m.provider_thread_id, m.reply_count, m.to_addresses from email_messages m
    join office_actions a on a.id = m.office_action_id join office_leads l on l.id = a.lead_id where m.office_agent_id = $1 and m.status = 'accepted' and l.status = 'active' and m.accepted_at > now() - interval '30 days'`, [ctx.agent.id]))
  for (const m of msgs) {
    try {
      const replies = await emailAdapter(account.provider).listReplies(accountRef(account), await accessToken(account.id), { internetMessageId: m.internet_message_id, providerThreadId: m.provider_thread_id })
      const fromLead = (replies ?? []).filter(r => m.to_addresses.includes(r.from))
      if (fromLead.length > m.reply_count) { await admin(db => db.query('update email_messages set reply_count = $2, reply_seen_at = now() where id = $1', [m.id, fromLead.length])); counts.replies_seen = (counts.replies_seen ?? 0) + 1 }
    } catch { /* reply tracking is best effort; it never changes what the agent may do */ }
  }
}

async function dueFollowups(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!, l = p.leadFollowup!
  const hc = await admin(db => conn(db, ctx.agent.org_id, p.hubspotConnectionId))
  if (!hc) throw new Blocked(await officeBlockReason(ctx.agent.org_id, p.hubspotConnectionId, 'HubSpot'))
  // a reply on any message in the thread stops the sequence
  // (an out-of-office reply this agent already sorted does not count: the cadence goes on)
  const replied = await admin(db => db.query<{ id: string }>(`select distinct l.id from office_leads l join office_actions a on a.lead_id = l.id join email_messages m on m.id = a.email_message_id
    where l.agent_id = $1 and l.status = 'active' and m.reply_count > (select count(*) from email_inbound i join office_inbound_handled h on h.inbound_id = i.id and h.agent_id = $1
      where i.thread_message_id = m.id and h.classification = 'out_of_office')`, [ctx.agent.id]))
  for (const r of replied) { await stopLead(r.id, 'the lead replied', actorOf(ctx), 'replied'); counts.stopped = (counts.stopped ?? 0) + 1 }
  // a first email that was cancelled before anything happened (the agent was paused) is proposed again
  const unsent = await admin(db => db.query<LeadRow>(`select l.* from office_leads l where l.agent_id = $1 and l.status = 'active' and l.touches = 0
    and not exists (select 1 from office_actions a where a.lead_id = l.id and a.status not in ('cancelled')) limit 50`, [ctx.agent.id]))
  for (const lead of unsent) { await proposeTouch(ctx, lead, 1, null, now); counts.proposed = (counts.proposed ?? 0) + 1 }
  const due = await admin(db => db.query<LeadRow>(`select * from office_leads where agent_id = $1 and status = 'active' and touches >= 1 and next_touch_at <= $2 order by next_touch_at limit 50`, [ctx.agent.id, now.toISOString()]))
  for (const lead of due) {
    if (lead.touches >= l.maxTouches) { await stopLead(lead.id, 'all follow-ups sent', actorOf(ctx), 'completed'); continue }
    const pending = await admin(db => db.one(`select id from office_actions where lead_id = $1 and status in ('draft','awaiting_approval','queued','executing','unknown')`, [lead.id]))
    if (pending) continue
    const c = await hubspotFor(hc).getContact(lead.hubspot_contact_id)
    const stop = async (why: string) => { await stopLead(lead.id, why, actorOf(ctx)); counts.stopped = (counts.stopped ?? 0) + 1 }
    if (!c) { await stop('the contact was deleted in HubSpot'); continue }
    if (c.optedOut) { await stop('the contact is opted out of email in HubSpot'); continue }
    if (c.lifecycleStage !== 'lead') { await stop(`the lifecycle stage changed to "${c.lifecycleStage ?? 'none'}"`); continue }
    if (c.email !== lead.email) { await stop("the contact's email address changed in HubSpot"); continue }
    const first = lead.thread_message_id ? await admin(db => db.one<{ meta: Record<string, unknown> }>('select meta from email_messages where id = $1', [lead.thread_message_id])) : null
    await proposeTouch(ctx, lead, lead.touches + 1, (first?.meta.subject as string | undefined) ?? null, now)
    counts.proposed = (counts.proposed ?? 0) + 1
  }
}

// ---------------------------------------------------------------- inbound (all mailbox agents)

type Inbound = { id: string; org_id: string; account_id: string; from_address: string; thread_message_id: string | null; received_at: string; key_id: string; content_ciphertext: string }

async function unhandledInbound(ctx: AgentCtx): Promise<Inbound[]> {
  const mailbox = ctx.policy?.mailboxAccountId
  if (!mailbox) return []
  return admin(db => db.query<Inbound>(`select i.id, i.org_id, i.account_id, i.from_address, i.thread_message_id, i.received_at, i.key_id, i.content_ciphertext from email_inbound i
    where i.account_id = $1 and i.org_id = $2 and i.status = 'accepted' and not i.auto_reply and i.key_id <> 'pending' and i.received_at > $3::timestamptz - interval '1 day'
      and not exists (select 1 from office_inbound_handled h where h.agent_id = $4 and h.inbound_id = i.id) order by i.received_at limit 50`,
    [mailbox, ctx.agent.org_id, ctx.agent.created_at, ctx.agent.id]))
}

function readInbound(i: Inbound): { subject: string; text: string } {
  try { return JSON.parse(decryptSecret(i.key_id, i.content_ciphertext, `email-inbound:${i.id}`)) as { subject: string; text: string } } catch { return { subject: '', text: '' } }
}

async function markHandled(ctx: AgentCtx, i: Inbound, category: string, outcome: string) {
  await admin(db => db.query(`insert into office_inbound_handled (org_id, agent_id, inbound_id, classification, outcome) values ($1,$2,$3,$4,$5) on conflict do nothing`, [ctx.agent.org_id, ctx.agent.id, i.id, category, outcome.slice(0, 200)]))
}

/** The office action and lead / meeting an inbound reply belongs to (by the thread the inbound webhook matched). */
async function threadOf(i: Inbound) {
  if (!i.thread_message_id) return null
  return admin(async db => {
    const a = await db.one<OfficeActionRow>(`select a.* from office_actions a join email_messages m on m.office_action_id = a.id where m.id = $1 and a.org_id = $2`, [i.thread_message_id, i.org_id])
    if (!a) return null
    const lead = a.lead_id ? await db.one<LeadRow>('select * from office_leads where id = $1', [a.lead_id]) : null
    const meeting = a.meeting_id ? await db.one<MeetingRow>('select * from office_meetings where id = $1', [a.meeting_id]) : null
    return { action: a, lead, meeting }
  })
}

async function meetingSchedulerActive(orgId: string, mailboxId: string) {
  return Boolean(await admin(db => db.one(`select a.id from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.org_id = $1 and a.kind = 'meeting_scheduler' and a.status = 'active' and p.policy->>'mailboxAccountId' = $2`, [orgId, mailboxId])))
}

async function leadInbound(ctx: AgentCtx, counts: Counts) {
  for (const i of await unhandledInbound(ctx)) {
    const t = await threadOf(i)
    if (!t?.lead || t.lead.agent_id !== ctx.agent.id || i.from_address !== t.lead.email) { await markHandled(ctx, i, 'not_ours', 'not a reply from one of this agent\'s leads'); continue }
    const c = readInbound(i)
    // an out-of-office answer is not a reply: noted, and the follow-up cadence continues
    if (classifyLeadReply(c.subject, c.text) === 'out_of_office') { await markHandled(ctx, i, 'out_of_office', 'automatic reply: the sequence continues'); continue }
    const { category } = classifyInbound(c.subject, c.text)
    if (category === 'unsubscribe') await stopLead(t.lead.id, 'unsubscribed', actorOf(ctx))
    else await stopLead(t.lead.id, 'the lead replied', actorOf(ctx), 'replied')
    counts.stopped = (counts.stopped ?? 0) + 1
    await markHandled(ctx, i, category, category === 'unsubscribe' ? 'stopped: unsubscribed' : 'stopped: replied')
  }
}

async function freeSlotsFor(ctx: AgentCtx, now: Date): Promise<Slot[]> {
  const p = ctx.policy!, s = p.scheduler!
  const cc = await admin(db => conn(db, ctx.agent.org_id, p.calendarConnectionId))
  if (!cc) throw new Blocked(await officeBlockReason(ctx.agent.org_id, p.calendarConnectionId, 'Google Calendar'))
  const busy = await calendarFor(cc).freeBusy({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + (s.horizonDays + 1) * 864e5).toISOString(), timeZone: p.timezone })
  return proposeSlots(busy, { timezone: p.timezone, days: s.days, dayStart: s.dayStart, dayEnd: s.dayEnd, durationMin: s.durationMin, bufferMin: s.bufferMin, minNoticeHours: s.minNoticeHours, horizonDays: s.horizonDays }, now, 3)
}

/** Propose three times to someone who asked to meet (from a reply, or because the customer asked). */
export async function startMeeting(ctx: AgentCtx, input: { contactEmail: string; name?: string | null; leadId?: string | null; hubspotContactId?: string | null; inboundId?: string | null; threadMessageId?: string | null; subject?: string | null }, now: Date) {
  const email = input.contactEmail.trim().toLowerCase()
  if (!isEmail(email)) throw new Blocked('not a valid email address')
  const slots = await freeSlotsFor(ctx, now)
  if (!slots.length) throw new Blocked('no free time within business hours in the next days')
  const s = ctx.policy!.scheduler!
  return admin(async db => {
    const m = input.inboundId
      ? await db.one<MeetingRow>(`insert into office_meetings (org_id, agent_id, lead_id, contact_email, hubspot_contact_id, proposed_slots, source_inbound_id) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning *`,
        [ctx.agent.org_id, ctx.agent.id, input.leadId ?? null, email, input.hubspotContactId ?? null, JSON.stringify(slots), input.inboundId])
      : await db.one<MeetingRow>(`insert into office_meetings (org_id, agent_id, lead_id, contact_email, hubspot_contact_id, proposed_slots) values ($1,$2,$3,$4,$5,$6) returning *`,
        [ctx.agent.org_id, ctx.agent.id, input.leadId ?? null, email, input.hubspotContactId ?? null, JSON.stringify(slots)])
    if (!m) return null
    const d = meetingProposal(input.name ?? null, s.senderName, slots, input.subject ?? null, s.durationMin)
    const { action } = await proposeAction(db, { agentId: ctx.agent.id, kind: 'send_email', purpose: 'Propose three meeting times', idempotencyKey: `meeting:${m.id}:proposal`, meetingId: m.id, now,
      payload: { type: 'email', to: email, subject: d.subject, body: d.body, inReplyToMessageId: input.threadMessageId ?? null, recipientSource: { kind: 'meeting', meetingId: m.id }, meta: { step: 'proposal', subject: d.subject } } })
    await officeAudit(db, { orgId: ctx.agent.org_id, entityType: 'office_meeting', entityId: m.id, event: 'meeting.proposing', actor: actorOf(ctx), detail: { slots: slots.length, action_id: action.id } })
    return { meeting: m, action }
  })
}

async function book(ctx: AgentCtx, m: MeetingRow, slotIndex: number, now: Date) {
  const slot = m.proposed_slots[slotIndex - 1]
  if (!slot) return null
  const p = ctx.policy!, s = p.scheduler!
  return admin(async db => {
    const r = await db.query(`update office_meetings set status = 'booking', chosen_slot = $2 where id = $1 and status = 'proposed' returning id`, [m.id, JSON.stringify(slot)])
    if (!r.length) return null
    const key = `meeting:${m.id}:event`
    return proposeAction(db, { agentId: ctx.agent.id, kind: 'create_event', purpose: 'Book the meeting time they chose', idempotencyKey: key, meetingId: m.id, now,
      payload: { type: 'event', eventId: eventIdFor(`${ctx.agent.org_id}:${key}`), summary: s.meetingTitle, description: `Booked by Deploi Office for ${m.contact_email}.`, start: slot.start, end: slot.end, timeZone: p.timezone,
        attendees: [m.contact_email], meet: Boolean(p.calendar?.allowMeet), bufferMin: s.bufferMin } })
  })
}

/**
 * Lead cases handed to this scheduler (the lead replied "interested"): propose three times to the lead, under
 * THIS agent's own policy and tiers. Nothing the lead agent was allowed carries over (lib/office/resolution.ts).
 */
async function handedCases(ctx: AgentCtx, now: Date, counts: Counts) {
  for (const h of await handedLeadCases(ctx.agent.id)) {
    const c = readInbound(h.inbound)
    try {
      const r = await startMeeting(ctx, { contactEmail: h.lead.email, name: h.lead.first_name, leadId: h.lead.id, hubspotContactId: h.lead.hubspot_contact_id, inboundId: h.inbound.id, threadMessageId: h.inbound.thread_message_id, subject: c.subject }, now)
      if (r) counts.meetings_proposed = (counts.meetings_proposed ?? 0) + 1
    } catch (e) { if (!(e instanceof Blocked)) throw e; counts.handoff_blocked = (counts.handoff_blocked ?? 0) + 1 }
  }
}

async function schedulerInbound(ctx: AgentCtx, now: Date, counts: Counts) {
  for (const i of await unhandledInbound(ctx)) {
    const t = await threadOf(i)
    const c = readInbound(i)
    const proposal = t?.meeting && t.meeting.agent_id === ctx.agent.id && t.meeting.status === 'proposed' && i.from_address === t.meeting.contact_email
    const { category, slot } = classifyInbound(c.subject, c.text, { proposal: Boolean(proposal) })
    if (proposal && category === 'slot_choice' && slot) {
      const r = await book(ctx, t!.meeting!, slot, now)
      await markHandled(ctx, i, category, r ? `booking slot ${slot}` : 'already booking')
      counts.booking = (counts.booking ?? 0) + 1
      continue
    }
    if (category === 'meeting_request') {
      try {
        const r = await startMeeting(ctx, { contactEmail: i.from_address, name: t?.lead?.first_name ?? null, leadId: t?.lead?.id ?? null, hubspotContactId: t?.lead?.hubspot_contact_id ?? null, inboundId: i.id, threadMessageId: i.thread_message_id, subject: c.subject }, now)
        await markHandled(ctx, i, category, r ? 'proposed three times' : 'already handled')
        counts.meetings_proposed = (counts.meetings_proposed ?? 0) + 1
      } catch (e) { if (!(e instanceof Blocked)) throw e; await markHandled(ctx, i, category, `not proposed: ${e.message}`) }
      continue
    }
    await markHandled(ctx, i, category, 'not a meeting request')
  }
}

async function customerReplyInbound(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!, cr = p.customerReply!
  const scheduler = await meetingSchedulerActive(ctx.agent.org_id, p.mailboxAccountId!)
  for (const i of await unhandledInbound(ctx)) {
    const t = await threadOf(i)
    const c = readInbound(i)
    const { category } = classifyInbound(c.subject, c.text, { proposal: Boolean(t?.meeting && t.meeting.status === 'proposed') })
    if (category === 'unsubscribe' || category === 'slot_choice' || (category === 'meeting_request' && scheduler)) { await markHandled(ctx, i, category, 'left to the lead or meeting agent'); continue }
    const d = customerReplyDraft(category as InboundCategory, cr.senderName, c.subject)
    const may = (cr.sendCategories as string[]).includes(category)
    await admin(db => proposeAction(db, { agentId: ctx.agent.id, kind: 'send_email', purpose: `Reply to a ${category.replace('_', ' ')}`, idempotencyKey: `reply:${ctx.agent.id}:${i.id}`, now,
      payload: { type: 'email', to: i.from_address, subject: d.subject, body: d.body, inReplyToMessageId: i.thread_message_id, recipientSource: { kind: 'inbound', inboundId: i.id }, meta: { category, subject: d.subject } },
      standingBlockers: may ? [] : [`replies to a ${category.replace('_', ' ')} always wait for a person`] }))
    await markHandled(ctx, i, category, 'reply drafted')
    counts.replies_drafted = (counts.replies_drafted ?? 0) + 1
  }
}

// ---------------------------------------------------------------- CRM Updater

async function crmUpdates(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!, u = p.crmUpdater!
  const hc = await admin(db => conn(db, ctx.agent.org_id, p.hubspotConnectionId))
  if (!hc) throw new Blocked(await officeBlockReason(ctx.agent.org_id, p.hubspotConnectionId, 'HubSpot'))
  const propose = (kind: 'crm_note' | 'crm_update_contact' | 'crm_deal_stage', key: string, purpose: string, payload: Parameters<typeof proposeAction>[1]['payload']) =>
    admin(db => proposeAction(db, { agentId: ctx.agent.id, kind, purpose, idempotencyKey: key, payload, now })).then(r => { if (!r.duplicate) counts.proposed = (counts.proposed ?? 0) + 1 })
  // what other office agents did, with the HubSpot contact it concerns
  const done = await admin(db => db.query<OfficeActionRow & { contact_id: string | null; agent_name: string }>(`select a.*, coalesce(l.hubspot_contact_id, m.hubspot_contact_id, ml.hubspot_contact_id) as contact_id, g.name as agent_name
    from office_actions a join office_agents g on g.id = a.agent_id left join office_leads l on l.id = a.lead_id left join office_meetings m on m.id = a.meeting_id left join office_leads ml on ml.id = m.lead_id
    where a.org_id = $1 and a.status = 'succeeded' and a.kind in ('send_email','create_event') and a.executed_at > $2 and a.agent_id <> $3
      and not exists (select 1 from office_actions x where x.org_id = a.org_id and x.idempotency_key = 'crmlog:' || a.id::text) order by a.executed_at limit 50`,
    [ctx.agent.org_id, new Date(now.getTime() - 14 * 864e5).toISOString(), ctx.agent.id]))
  for (const a of done) {
    if (!a.contact_id) continue
    if (a.kind === 'send_email' && !u.logEmails) continue
    if (a.kind === 'create_event' && !u.logMeetings) continue
    const key = `crmlog:${a.id}`
    const marker = crmMarker(`${ctx.agent.org_id}:${key}`, sha)
    const when = new Date(a.executed_at ?? now).toISOString().slice(0, 16).replace('T', ' ')
    const body = a.payload.type === 'email'
      ? `Email sent by Deploi Office (${a.agent_name}) to ${a.payload.to} on ${when} UTC. Subject: "${a.payload.subject.slice(0, 200)}". Ref ${marker}`
      : a.payload.type === 'event' ? `Meeting booked by Deploi Office (${a.agent_name}): "${a.payload.summary}" ${a.payload.start.slice(0, 16).replace('T', ' ')} UTC with ${a.payload.attendees.join(', ')}. Ref ${marker}` : ''
    if (body) await propose('crm_note', key, a.kind === 'send_email' ? 'Log an email on the contact' : 'Log a meeting on the contact', { type: 'note', contactId: a.contact_id, body, marker })
  }
  if (!u.rules.length) return
  const events = await admin(db => db.query<{ on: string; ref: string; contact_id: string }>(`
      select 'lead_replied' as on, l.id::text as ref, l.hubspot_contact_id as contact_id from office_leads l where l.org_id = $1 and l.status = 'replied' and l.updated_at > $2
      union all select 'lead_unsubscribed', l.id::text, l.hubspot_contact_id from office_leads l where l.org_id = $1 and l.status = 'stopped' and l.stop_reason = 'unsubscribed' and l.updated_at > $2
      union all select 'meeting_booked', m.id::text, coalesce(m.hubspot_contact_id, l.hubspot_contact_id) from office_meetings m left join office_leads l on l.id = m.lead_id where m.org_id = $1 and m.status = 'booked' and m.updated_at > $2`,
    [ctx.agent.org_id, new Date(now.getTime() - 14 * 864e5).toISOString()]))
  const hs = hubspotFor(hc)
  for (const ev of events) {
    if (!ev.contact_id) continue
    for (const [n, r] of u.rules.entries()) {
      if (r.on !== ev.on) continue
      const ruleKey = sha(JSON.stringify(r)).slice(0, 12)
      if (r.lifecycleStage) await propose('crm_update_contact', `crmrule:${ruleKey}:${ev.on}:${ev.ref}:stage`, `Rule ${n + 1}: set the lifecycle stage`, { type: 'contact_update', contactId: ev.contact_id, properties: { lifecyclestage: r.lifecycleStage } })
      if (r.dealStage) for (const dealId of await hs.listContactDeals(ev.contact_id)) await propose('crm_deal_stage', `crmrule:${ruleKey}:${ev.on}:${ev.ref}:deal:${dealId}`, `Rule ${n + 1}: move the deal stage`, { type: 'deal_stage', dealId, stage: r.dealStage })
    }
  }
}

// ---------------------------------------------------------------- runs

const actorOf = (ctx: AgentCtx) => `office-agent:${ctx.agent.name.slice(0, 60)}@v${ctx.policyVersion}`

/** Run one office agent now (schedule, "Run now" or a test). Its own queued actions are carried out at the end, a bounded number. */
export async function runOfficeAgent(agentId: string, opts: { trigger?: 'manual' | 'schedule' | 'test'; now?: Date; execute?: boolean } = {}) {
  const now = opts.now ?? new Date()
  const ctx = await admin(db => agentCtx(db, agentId))
  if (!ctx || ctx.agent.status !== 'active' || !ctx.policy || ctx.policyStatus !== 'active') return { status: 'blocked' as const, reason: 'the agent is not active', counts: {} }
  const p: OfficePolicy = ctx.policy
  const run = await admin(async db => {
    await db.query('update office_agents set last_run_at = $2, next_run_at = $3 where id = $1', [agentId, now.toISOString(), new Date(now.getTime() + p.schedule.everyMinutes * 60e3).toISOString()])
    return (await db.one<{ id: string }>(`insert into office_runs (org_id, agent_id, policy_id, policy_version, trigger) values ($1,$2,$3,$4,$5) returning id`, [ctx.agent.org_id, agentId, ctx.policyId, ctx.policyVersion, opts.trigger ?? 'schedule']))!
  })
  const counts: Counts = {}
  let status: 'completed' | 'failed' | 'blocked' = 'completed', reason: string | null = null
  try {
    if (p.kind === 'lead_followup') { await leadInbound(ctx, counts); await checkReplies(ctx, counts); await pollLeads(ctx, now, counts); await dueFollowups(ctx, now, counts) }
    if (p.kind === 'meeting_scheduler') { await handedCases(ctx, now, counts); await schedulerInbound(ctx, now, counts) }
    if (p.kind === 'customer_reply') await customerReplyInbound(ctx, now, counts)
    if (p.kind === 'crm_updater') { await crmUpdates(ctx, now, counts); await proposeCaseCrmNotes(ctx, now, counts) }
    if (p.kind === 'accounts_receivable') await runReceivables(ctx, now, counts)
    if (p.kind === 'email_operations') await emailOperationsRun(ctx, now, counts)
    if (opts.execute !== false) counts.executed = (await executeDue(ctx.agent.org_id, { agentId, now })).length
    if (p.kind === 'accounts_receivable' && opts.execute !== false) await syncReceivables(ctx, now, counts)
  } catch (e) {
    status = e instanceof Blocked || e instanceof ReceivablesBlocked ? 'blocked' : 'failed'
    reason = e instanceof Blocked || e instanceof ReceivablesBlocked || e instanceof OfficeAuthError ? e.message : e instanceof OfficeHttpError ? e.message : 'the run stopped on an unexpected error'
    if (e instanceof OfficeAuthError) status = 'blocked'
    if (status === 'failed') log.error('office.run.failed', { agent_id: agentId, error: (e as Error).message?.slice(0, 300) })
  }
  // the Resolution Engine cases follow what this run did (a failure here never fails the run; the durable check catches up)
  try { await syncOfficeCases(ctx.agent.org_id, now, { agentId }) } catch (e) { log.error('office.case_sync_failed', { agent_id: agentId, error: (e as Error).message?.slice(0, 300) }) }
  await admin(async db => {
    await db.query(`update office_runs set status = $2, status_reason = $3, counts = $4, finished_at = now() where id = $1`, [run.id, status, reason, JSON.stringify(counts)])
    await officeAudit(db, { orgId: ctx.agent.org_id, entityType: 'office_run', entityId: run.id, event: `run.${status}`, actor: actorOf(ctx), detail: { agent_id: agentId, kind: p.kind, policy_version: ctx.policyVersion, counts, reason } })
  })
  return { runId: run.id, status, reason, counts }
}

/**
 * Carry out due queued actions of one organization (optionally one agent), oldest first, at most `limit`
 * in total. Actions queued by an execution (a booking's confirmation email) are picked up in the same call.
 */
export async function executeDue(orgId: string, opts: { agentId?: string; now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? officeConfig.actionsPerOrg
  const seen = new Set<string>()
  const out: Awaited<ReturnType<typeof executeOfficeAction>>[] = []
  for (let round = 0; round < 3 && out.length < limit; round++) {
    const due = await admin(db => db.query<{ id: string }>(`select id from office_actions where org_id = $1 and status = 'queued' and (next_attempt_at is null or next_attempt_at <= $2)
      and ($3::uuid is null or agent_id = $3) and not (id = any($5::uuid[])) order by created_at limit $4`, [orgId, now.toISOString(), opts.agentId ?? null, limit - out.length, [...seen]]))
    if (!due.length) break
    for (const d of due) { seen.add(d.id); out.push(await executeOfficeAction(d.id, { now })) }
  }
  return out
}
