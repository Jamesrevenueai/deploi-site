/**
 * Deploi Office flagship workflow on the Resolution Engine: CRM follow-up and commitment resolution.
 *
 * Every lead, meeting request and CRM commitment the Lead Follow-up, Meeting Scheduler and CRM Updater agents
 * act on is a case (suite office, source hubspot, one open case per contact and kind):
 *   lead_followup     dedupe lead_followup:hubspot:<contact>
 *   meeting_request   dedupe meeting_request:<hubspot:contact | email:address>  (a meeting not tied to a lead case)
 *   crm_commitment    dedupe crm_commitment:hubspot:<contact>                    (stage changes the CRM Updater's rules make)
 *   email_unanswered  lib/office/email-ops.ts
 *
 * The case follows the Office records (lib/office/run.ts, actions.ts), one allowed transition at a time:
 *   detected -> proposed (draft) -> awaiting_approval -> executing (send) -> waiting_external (reply window;
 *   next check = the follow-up cadence) -> investigating (a reply arrived: interested / not interested /
 *   opt-out / question / out-of-office, deterministic keyword rules) -> proposed..waiting_external again while
 *   scheduling (three times proposed, then the booking) -> verifying -> resolved, only with evidence:
 *   - a meeting: the event read back from Google Calendar, not cancelled, with the lead as a guest;
 *   - "not interested" or an opt-out: the recorded reply plus the CRM note the CRM Updater wrote, read back from
 *     HubSpot (an opt-out also suppresses the address for the organization); a HubSpot opt-out or lifecycle
 *     change seen on a fresh read of the contact is itself the CRM evidence;
 *   - a CRM stage change: the HubSpot contact or deal re-read with the new stage.
 * Exhausted cadence with no reply (the reply window after the last email passed): ESCALATED, never resolved
 * and not silently cancelled — a person decides to call, re-engage later or close it. A late reply still moves it.
 * A question (or anything that needs a person) escalates; an out-of-office reply leaves the cadence running.
 *
 * Handoffs: an interested lead is handed (handOffCase) to the organization's Meeting Scheduler, a "not
 * interested" or opt-out to its CRM Updater. Ownership only: the new owner proposes its own actions under its
 * own policy and tiers (a scheduler with calendar drafts only books nothing), and the lead agent's permissions
 * never travel with the case. Reply text is data: it only picks the class; it never adds a recipient.
 *
 * Cases advance from three places: the end of every agent run, every settled action (approved, executed,
 * declined), and the durable `case.check` job through the kind checkers registered below (fresh reads of
 * HubSpot and Google Calendar). While the organization's stop is on, every open Office case is blocked and
 * nothing advances.
 */
import { admin } from '../db'
import { suppressAddresses } from '../email/suppression'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { addEvidence, caseForRecord, handOffCase, openCase, registerCaseKind, resolveCase, TERMINAL, type CaseRow, type Evidence } from '../cases'
import { agentCtx, onOfficeActionSettled, proposeAction, sha, stopLead, type AgentCtx, type OfficeActionRow } from './actions'
import { calendarFor, hubspotFor } from './providers'
import { crmMarker, newText } from './content'
import type { OfficeConnectionRow } from './connections'
import type { HubSpotContact } from './types'
import { actorOf, blockForStop, day, ensureActionRecorded, ensureLink, inboundContent, iso, linkActions, moveCase, RESOLUTION_ACTOR, stepFor, stopped, type CaseTarget, type InboundMail } from './case-sync'
import { syncEmailCase, syncEmailCases } from './email-ops'

export const OFFICE_CASE_KINDS = ['lead_followup', 'meeting_request', 'crm_commitment', 'email_unanswered'] as const

// ---------------------------------------------------------------- reply classification (deterministic)

export type LeadReplyClass = 'interested' | 'not_interested' | 'opt_out' | 'question' | 'out_of_office'
export const REPLY_LABEL: Record<LeadReplyClass, string> = { interested: 'interested', not_interested: 'not interested', opt_out: 'opt-out', question: 'question (needs a person)', out_of_office: 'out of office' }

const OOO = /\b(out of (the )?office|on (annual |parental |maternity |paternity )?leave|on (vacation|holiday)|away (from (the|my) (office|desk) )?until|limited access to (my )?e-?mail|automatic reply|auto(matic)?[- ]?reply|autoreply)\b/
const OPT_OUT = /\b(unsubscribe|opt[ -]?out|remove me|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email))\b/
const NOT_INTERESTED = /\b(not interested|no thanks|no,? thank you|not (a fit|the right fit|right now|for us|at this time)|we('| a)?re (all )?set|went with (another|someone|a different)|already (have|use|found|work with)|not looking|pass on this|no need)\b/
const INTERESTED = /\b(interested|sounds (good|great|interesting)|let'?s (talk|chat|meet|do it|set (it|something) up)|tell me more|(would|i'?d) love to|happy to (talk|chat|meet|hop on)|keen|yes|sure|book|meet|meeting|call|demo|schedule|availability|available|time to talk)\b/

/**
 * One class for a lead's reply, from its subject and new text (quoted history ignored). An automatic reply
 * flagged by the inbound webhook is out of office. Order matters: opt-out wins over everything, "not
 * interested" over "interested". Anything else needs a person ("question").
 */
export function classifyLeadReply(subject: string, text: string, opts: { autoReply?: boolean } = {}): LeadReplyClass {
  if (opts.autoReply) return 'out_of_office'
  const t = `${subject.replace(/^(\s*(re|aw|fwd?):\s*)+/i, '')}\n${newText(text)}`.toLowerCase()
  if (OPT_OUT.test(t)) return 'opt_out'
  if (OOO.test(t)) return 'out_of_office'
  if (NOT_INTERESTED.test(t)) return 'not_interested'
  if (INTERESTED.test(t)) return 'interested'
  return 'question'
}

// ---------------------------------------------------------------- shared reads

type Lead = { id: string; org_id: string; agent_id: string; hubspot_contact_id: string; email: string; first_name: string | null; company: string | null; status: string; stop_reason: string | null; touches: number; last_touch_at: string | null; next_touch_at: string | null; created_at: string; updated_at: string }
type Meeting = { id: string; org_id: string; agent_id: string; lead_id: string | null; contact_email: string; hubspot_contact_id: string | null; status: string; status_reason: string | null; proposed_slots: unknown[]; calendar_event_id: string | null; created_at: string; updated_at: string }

async function conn(orgId: string, id: string | null | undefined): Promise<OfficeConnectionRow | null> {
  if (!id) return null
  return admin(db => db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2 and status = 'active'`, [id, orgId]))
}

/** The organization's active agent of a kind (oldest first), with its policy. */
async function activeAgent(orgId: string, kind: 'meeting_scheduler' | 'crm_updater'): Promise<AgentCtx | null> {
  const a = await admin(db => db.one<{ id: string }>(`select id from office_agents where org_id = $1 and kind = $2 and status = 'active' and active_policy_id is not null order by created_at limit 1`, [orgId, kind]))
  return a ? admin(db => agentCtx(db, a.id)) : null
}

async function handTo(c: CaseRow, to: AgentCtx, reason: string, actor: string) {
  if (c.agent_kind === 'office' && c.agent_ref === to.agent.id) return
  await admin(db => handOffCase(db, c.id, { kind: 'office', ref: to.agent.id }, { actor, reason }))
}

const LEAD_CRITERIA = 'Resolved only when the outcome is observed in a source of truth: a meeting read back from Google Calendar with the lead as a guest; the lead\'s "not interested" or opt-out reply recorded and the CRM update read back from HubSpot; or a stage change or opt-out read back from HubSpot. Sending emails never resolves it; no reply after the whole cadence escalates it to you.'

async function leadCase(lead: Lead, ctx: AgentCtx | null): Promise<CaseRow> {
  const existing = await admin(db => caseForRecord(db, lead.org_id, 'office_lead', lead.id))
  if (existing) return existing
  const name = [lead.first_name, lead.company && `(${lead.company})`].filter(Boolean).join(' ') || lead.email
  return (await admin(db => openCase(db, {
    orgId: lead.org_id, suite: 'office', kind: 'lead_followup', sourceApp: 'hubspot', dedupeKey: `lead_followup:hubspot:${lead.hubspot_contact_id}`,
    title: `Follow up ${name}`.slice(0, 300), problem: `${lead.email} is a lead in HubSpot (contact ${lead.hubspot_contact_id}) waiting for a first contact and a follow-up until they answer.`,
    whyItMatters: 'A lead nobody follows up is a lost opportunity.', agent: { kind: 'office', ref: lead.agent_id },
    evidence: [{ label: `HubSpot contact ${lead.hubspot_contact_id} (${lead.email}) is in lifecycle stage "lead"`, source: 'hubspot', observedAt: iso(lead.created_at), ref: { type: 'hubspot_contact', id: lead.hubspot_contact_id } }],
    records: [{ type: 'office_lead', id: lead.id, label: lead.email }, { type: 'hubspot_contact', id: lead.hubspot_contact_id }],
    verification: { criteria: LEAD_CRITERIA, rule: { kind: 'lead_followup', meeting: 'calendar event read back with the lead as attendee', declined: 'reply recorded + HubSpot note read back', crm: 'HubSpot record re-read', no_reply: 'escalated' } },
    nextAction: 'Write the first email.', actor: actorOf(ctx),
  }))).case
}

/** The lead's replies in its own threads (accepted mail from the lead's address), oldest first. */
async function leadReplies(lead: Lead): Promise<InboundMail[]> {
  return admin(db => db.query<InboundMail>(`select i.* from email_inbound i join email_messages m on m.id = i.thread_message_id join office_actions a on a.id = m.office_action_id
    where a.lead_id = $1 and i.org_id = $2 and i.status = 'accepted' and lower(i.from_address) = lower($3) order by i.received_at`, [lead.id, lead.org_id, lead.email]))
}

const replyEvidence = (i: InboundMail, cls: LeadReplyClass): Evidence => ({ label: `Reply from ${i.from_address} received ${iso(i.received_at).slice(0, 16).replace('T', ' ')} UTC, classified "${REPLY_LABEL[cls]}"`,
  source: 'deploi_email', observedAt: iso(i.received_at), ref: { type: 'email_inbound', id: i.id }, detail: { classification: cls, auto_reply: i.auto_reply } })

async function freshContact(orgId: string, connectionId: string | null | undefined, contactId: string): Promise<{ contact: HubSpotContact | null } | null> {
  const hc = await conn(orgId, connectionId)
  if (!hc) return null
  try { return { contact: await hubspotFor(hc).getContact(contactId) } } catch { return null }
}

// ---------------------------------------------------------------- lead follow-up cases

/**
 * Bring a lead's case up to date with its records. `fresh`: also re-read the HubSpot contact of a lead still
 * in follow-up (the durable check does), so an opt-out or stage change stops the cadence before the next email.
 */
export async function syncLeadCase(leadId: string, now: Date, opts: { fresh?: boolean } = {}): Promise<CaseRow | null> {
  const lead = await admin(db => db.one<Lead>('select * from office_leads where id = $1', [leadId]))
  if (!lead) return null
  const stop = await stopped(lead.org_id)
  const ctx = await admin(db => agentCtx(db, lead.agent_id))
  const c = await leadCase(lead, ctx)
  if (TERMINAL.includes(c.status)) return c
  if (stop) { await blockForStop(lead.org_id, stop, { caseId: c.id }); return c }
  const actor = actorOf(ctx)
  const acts = await admin(db => db.query<OfficeActionRow>('select * from office_actions where lead_id = $1 order by created_at', [lead.id]))
  await linkActions(c.id, acts, actor)
  for (const a of acts) if (a.status === 'succeeded' && a.email_message_id)
    await ensureActionRecorded(c.id, { summary: `${a.purpose} sent to ${lead.email} (accepted by the provider)`, ref: { type: 'email_message', id: a.email_message_id }, detail: { office_action_id: a.id, touch: (a.payload as { meta?: { touch?: number } }).meta?.touch ?? null, approval: a.approval_kind } }, actor)

  if (opts.fresh && lead.status === 'active' && ctx?.policy?.hubspotConnectionId) {
    const r = await freshContact(lead.org_id, ctx.policy.hubspotConnectionId, lead.hubspot_contact_id)
    if (r && !r.contact) await stopLead(lead.id, 'the contact was deleted in HubSpot', actor)
    else if (r?.contact?.optedOut) await stopLead(lead.id, 'the contact is opted out of email in HubSpot', actor)
    else if (r?.contact && r.contact.lifecycleStage !== 'lead') await stopLead(lead.id, `the lifecycle stage changed to "${r.contact.lifecycleStage ?? 'none'}"`, actor)
    if (r) Object.assign(lead, await admin(db => db.one<Lead>('select * from office_leads where id = $1', [leadId])))
  }

  // replies: an out-of-office is noted and the cadence goes on; the first other reply decides
  let reply: { i: InboundMail; cls: LeadReplyClass } | null = null
  for (const i of await leadReplies(lead)) {
    const content = inboundContent(i)
    const cls = classifyLeadReply(content.subject, content.text, { autoReply: i.auto_reply })
    const first = !(await admin(db => db.one('select 1 from case_links where case_id = $1 and ref_type = $2 and ref_id = $3', [c.id, 'email_inbound', i.id])))
    if (first) {
      await ensureLink(c.id, { type: 'email_inbound', id: i.id, label: `Reply from ${i.from_address}` }, actor)
      await admin(db => addEvidence(db, c.id, replyEvidence(i, cls), actor))
      if (cls !== 'out_of_office') await moveCase(c.id, { status: 'investigating', reason: `${lead.email} replied; classified "${REPLY_LABEL[cls]}"` }, actor)
    }
    if (cls !== 'out_of_office') { reply = { i, cls }; break }
  }
  const target = reply ? await afterReply(c, lead, ctx, reply, now, actor) : await withoutReply(c, lead, ctx, acts, now, actor)
  if (target) await moveCase(c.id, target, actor)
  return admin(db => db.one<CaseRow>('select * from cases where id = $1', [c.id]))
}

async function withoutReply(c: CaseRow, lead: Lead, ctx: AgentCtx | null, acts: OfficeActionRow[], now: Date, actor: string): Promise<CaseTarget | null> {
  const l = ctx?.policy?.leadFollowup
  if (lead.status === 'stopped' || lead.status === 'completed' || lead.status === 'replied') {
    const why = lead.stop_reason ?? ''
    if (lead.status === 'completed') {
      const windowEnd = new Date(new Date(lead.last_touch_at ?? lead.updated_at).getTime() + (l?.followupDays ?? 3) * 864e5)
      if (now.getTime() < windowEnd.getTime()) return { status: 'waiting_external', reason: `All ${lead.touches} emails sent; waiting for a reply until ${day(windowEnd)}`, nextAction: null, nextCheckAt: windowEnd }
      return { status: 'escalated', reason: `No reply after ${lead.touches} email${lead.touches === 1 ? '' : 's'} and the reply window: the follow-up cadence is exhausted`, nextAction: 'Decide: call them, re-engage later, or close the case. It is not counted as resolved.', nextCheckAt: null }
    }
    if (lead.status === 'replied') return { status: 'escalated', reason: `${lead.email} replied (the mailbox showed that a reply arrived, not its text)`, nextAction: 'Read the reply and answer it; mark the case handled when done.', nextCheckAt: null }
    if (/opted out of email in HubSpot|lifecycle stage changed/.test(why)) return resolveFromHubSpot(c, lead, ctx, actor, now)
    if (/declined/.test(why)) return { status: 'cancelled', reason: `Closed: ${why}; nothing was sent`, nextCheckAt: null }
    if (/deleted in HubSpot/.test(why)) return { status: 'cancelled', reason: `Closed: ${why}`, nextCheckAt: null }
    if (/the agent was (revoked|deleted)/.test(why)) return { status: 'cancelled', reason: `Closed: ${why}; nobody is following this lead up`, nextCheckAt: null }
    if (why === 'unsubscribed') return { status: 'escalated', reason: `${lead.email} unsubscribed`, nextAction: 'Record it in HubSpot; the case closes when the CRM shows it.', nextCheckAt: null }
    return { status: 'escalated', reason: `Follow-up stopped: ${why || lead.status}`, nextAction: 'Check the lead in HubSpot and decide how to go on.', nextCheckAt: null }
  }
  const latest = acts[acts.length - 1]
  if (!latest) return null
  if (ctx && ctx.agent.status !== 'active' && ['cancelled', 'draft', 'awaiting_approval'].includes(latest.status)) return { status: 'blocked', reason: `The Lead Follow-up agent is ${ctx.agent.status}: nothing is sent`, nextAction: 'Resume the agent to continue the follow-up.' }
  if (latest.status === 'succeeded') {
    const touch = Number((latest.payload as { meta?: { touch?: number } }).meta?.touch ?? lead.touches)
    const next = lead.next_touch_at ? new Date(lead.next_touch_at) : null
    return { status: 'waiting_external', reason: `Email ${touch} of ${l?.maxTouches ?? touch} sent; waiting for a reply${next ? ` (next follow-up ${day(next)})` : ''}`, nextAction: null, nextCheckAt: next ?? new Date(now.getTime() + 864e5) }
  }
  return stepFor(latest, latest.purpose)
}

/** HubSpot itself shows the outcome (opted out, or no longer a lead): a fresh read of the contact is the evidence. */
async function resolveFromHubSpot(c: CaseRow, lead: Lead, ctx: AgentCtx | null, actor: string, now: Date): Promise<CaseTarget | null> {
  const r = await freshContact(lead.org_id, ctx?.policy?.hubspotConnectionId, lead.hubspot_contact_id)
  if (!r) return { status: 'verifying', reason: 'Checking the contact in HubSpot', nextCheckAt: new Date(now.getTime() + 3600e3) }
  if (!r.contact) return { status: 'cancelled', reason: 'Closed: the contact was deleted in HubSpot', nextCheckAt: null }
  const opted = r.contact.optedOut, stage = r.contact.lifecycleStage
  if (!opted && stage === 'lead') return { status: 'escalated', reason: 'The follow-up stopped, but HubSpot still shows an opted-in lead', nextAction: 'Check the contact in HubSpot.', nextCheckAt: null }
  if (opted) await admin(db => suppressAddresses(db, { orgId: lead.org_id, addresses: [lead.email], reason: 'unsubscribed', detail: 'opted out of email in HubSpot (hs_email_optout)', actor }))
  await moveCase(c.id, { status: 'verifying', reason: 'Reading the contact back from HubSpot' }, actor)
  await admin(db => resolveCase(db, c.id, { actor, verifiedBy: 'HubSpot (fresh read of the contact)',
    summary: opted ? `${lead.email} is opted out of email in HubSpot; no further follow-up (address suppressed)` : `HubSpot shows ${lead.email} moved to lifecycle stage "${stage ?? 'none'}"`,
    evidence: [{ label: opted ? `HubSpot contact ${lead.hubspot_contact_id}: hs_email_optout = true` : `HubSpot contact ${lead.hubspot_contact_id}: lifecycle stage "${stage ?? 'none'}"`, source: 'hubspot', observedAt: now.toISOString(), ref: { type: 'hubspot_contact', id: lead.hubspot_contact_id }, detail: { optedOut: opted, lifecycleStage: stage } }] }))
  return null
}

async function afterReply(c: CaseRow, lead: Lead, ctx: AgentCtx | null, reply: { i: InboundMail; cls: LeadReplyClass }, now: Date, actor: string): Promise<CaseTarget | null> {
  if (reply.cls === 'question') return { status: 'escalated', reason: `${lead.email} replied with a question or something that needs a person`, nextAction: 'Read the reply in the inbox and answer it; mark the case handled when done.', nextCheckAt: null }
  if (reply.cls === 'interested') return scheduling(c, lead, reply, now, actor)
  // not interested / opt-out: stop, (opt-out) suppress, and have the outcome written to HubSpot and read back
  if (lead.status === 'active') await stopLead(lead.id, reply.cls === 'opt_out' ? 'unsubscribed' : 'the lead replied', actor, reply.cls === 'opt_out' ? 'stopped' : 'replied')
  if (reply.cls === 'opt_out') await admin(db => suppressAddresses(db, { orgId: lead.org_id, addresses: [lead.email], reason: 'unsubscribed', sourceMessageId: null, detail: 'asked not to be contacted (reply to Deploi Office)', actor }))
  return crmOutcome(c, lead, reply, now, actor)
}

/** The CRM Updater writes the outcome as a note on the contact; the case resolves when HubSpot shows it. */
async function crmOutcome(c: CaseRow, lead: Lead, reply: { i: InboundMail; cls: LeadReplyClass }, now: Date, actor: string): Promise<CaseTarget | null> {
  const note = await admin(db => db.one<OfficeActionRow>(`select * from office_actions where org_id = $1 and idempotency_key = $2`, [lead.org_id, `case:${c.id}:crm_outcome`]))
  const what = reply.cls === 'opt_out' ? 'opted out' : 'not interested'
  if (!note) {
    const crm = await activeAgent(lead.org_id, 'crm_updater')
    if (!crm) {
      // no CRM Updater: the owner records it; a fresh read of HubSpot showing it closes the case
      const r = await freshContact(lead.org_id, (await admin(db => agentCtx(db, lead.agent_id)))?.policy?.hubspotConnectionId, lead.hubspot_contact_id)
      if (r?.contact && (r.contact.optedOut || r.contact.lifecycleStage !== 'lead')) return resolveFromHubSpot(c, lead, await admin(db => agentCtx(db, lead.agent_id)), actor, now)
      return { status: 'escalated', reason: `${lead.email} replied "${what}". No CRM Updater agent is active to record it in HubSpot`, nextAction: 'Record it in HubSpot (opt out or change the stage); the next check reads the contact and closes the case.', nextCheckAt: new Date(now.getTime() + 864e5) }
    }
    await handTo(c, crm, `The lead replied "${what}": the CRM Updater records it in HubSpot`, actor)
    return { status: 'investigating', reason: `${lead.email} replied "${what}"; handed to the CRM Updater to record it in HubSpot`, nextAction: 'The CRM Updater proposes a note on the contact on its next run.', nextCheckAt: crm.agent.next_run_at ? new Date(Math.max(new Date(crm.agent.next_run_at).getTime(), now.getTime()) + 60e3) : new Date(now.getTime() + 3600e3) }
  }
  await ensureLink(c.id, { type: 'office_action', id: note.id, label: note.purpose }, actor)
  if (note.status !== 'succeeded') return stepFor(note, 'Recording the reply in HubSpot')
  await ensureActionRecorded(c.id, { summary: 'Wrote the reply outcome as a note on the HubSpot contact', ref: { type: 'hubspot_note', id: note.external_id ?? note.id }, detail: { office_action_id: note.id } }, actor)
  await moveCase(c.id, { status: 'verifying', reason: 'Reading the note back from HubSpot' }, actor)
  const crmCtx = await admin(db => agentCtx(db, note.agent_id))
  const hc = await conn(lead.org_id, crmCtx?.policy?.hubspotConnectionId)
  let read: { id: string; body: string } | null = null
  try { read = hc && note.external_id ? await hubspotFor(hc).getNote(note.external_id) : null } catch { read = null }
  const marker = note.payload.type === 'note' ? note.payload.marker : ''
  if (!read || !read.body.includes(marker)) return { status: 'verifying', reason: 'The note could not be read back from HubSpot yet; checking again', nextCheckAt: new Date(now.getTime() + 3600e3) }
  const ev: Evidence[] = [replyEvidence(reply.i, reply.cls), { label: `HubSpot note ${read.id} on contact ${lead.hubspot_contact_id} read back`, source: 'hubspot', observedAt: now.toISOString(), ref: { type: 'hubspot_note', id: read.id } }]
  if (reply.cls === 'opt_out') {
    const s = await admin(db => db.one<{ created_at: string }>('select created_at from email_suppressions where org_id = $1 and address = $2', [lead.org_id, lead.email.toLowerCase()]))
    if (s) ev.push({ label: `${lead.email} is suppressed for this organization: nothing more is sent`, source: 'deploi_email', observedAt: iso(s.created_at), ref: { type: 'email_suppression', id: lead.email.toLowerCase() } })
  }
  await admin(db => resolveCase(db, c.id, { actor, verifiedBy: 'HubSpot (fresh read of the note) and the recorded reply', summary: `${lead.email} replied "${what}"; recorded in HubSpot${reply.cls === 'opt_out' ? ' and the address is suppressed' : ''}`, evidence: ev }))
  return null
}

async function scheduling(c: CaseRow, lead: Lead, reply: { i: InboundMail; cls: LeadReplyClass }, now: Date, actor: string): Promise<CaseTarget | null> {
  if (lead.status === 'active') await stopLead(lead.id, 'the lead replied', actor, 'replied')
  const meeting = await admin(db => db.one<Meeting>('select * from office_meetings where lead_id = $1 order by created_at desc limit 1', [lead.id]))
  if (meeting) return meetingStep(c, meeting, now, actor)
  const sched = await activeAgent(lead.org_id, 'meeting_scheduler')
  if (!sched) return { status: 'escalated', reason: `${lead.email} is interested. No Meeting Scheduler agent is active to propose times`, nextAction: 'Reply with a few times yourself, or add the Meeting Scheduler.', nextCheckAt: new Date(now.getTime() + 864e5) }
  await handTo(c, sched, 'The lead is interested: the Meeting Scheduler proposes times under its own permissions', actor)
  return { status: 'investigating', reason: `Scheduling: handed to the Meeting Scheduler (${sched.agent.name}); it proposes three times on its next run`, nextAction: 'The Meeting Scheduler proposes three times by email.',
    nextCheckAt: new Date(Math.max(new Date(sched.agent.next_run_at ?? now).getTime(), now.getTime()) + 60e3) }
}

/** Open lead cases handed to this Meeting Scheduler that still have no meeting: the scheduler's run proposes times for them. */
export async function handedLeadCases(schedulerId: string): Promise<{ caseId: string; lead: Lead; inbound: InboundMail }[]> {
  const rows = await admin(db => db.query<{ case_id: string; lead_id: string }>(`select c.id as case_id, l.ref_id as lead_id from cases c join case_links l on l.case_id = c.id and l.ref_type = 'office_lead'
    where c.kind = 'lead_followup' and c.agent_kind = 'office' and c.agent_ref = $1 and c.status not in ('resolved','cancelled','blocked')
      and not exists (select 1 from office_meetings m where m.lead_id::text = l.ref_id) limit 25`, [schedulerId]))
  const out: { caseId: string; lead: Lead; inbound: InboundMail }[] = []
  for (const r of rows) {
    const lead = await admin(db => db.one<Lead>('select * from office_leads where id = $1', [r.lead_id]))
    if (!lead) continue
    for (const i of await leadReplies(lead)) {
      const content = inboundContent(i)
      const cls = classifyLeadReply(content.subject, content.text, { autoReply: i.auto_reply })
      if (cls === 'out_of_office') continue
      if (cls === 'interested') out.push({ caseId: r.case_id, lead, inbound: i })
      break
    }
  }
  return out
}

// ---------------------------------------------------------------- meetings

async function meetingStep(c: CaseRow, m: Meeting, now: Date, actor: string): Promise<CaseTarget | null> {
  await ensureLink(c.id, { type: 'office_meeting', id: m.id, label: `Meeting with ${m.contact_email}` }, actor)
  const acts = await admin(db => db.query<OfficeActionRow>('select * from office_actions where meeting_id = $1 order by created_at', [m.id]))
  await linkActions(c.id, acts, actor)
  const proposal = acts.find(a => a.idempotency_key === `meeting:${m.id}:proposal`)
  const event = acts.find(a => a.idempotency_key === `meeting:${m.id}:event`)
  if (proposal?.status === 'succeeded' && proposal.email_message_id) await ensureActionRecorded(c.id, { summary: `Proposed three times to ${m.contact_email} (accepted by the provider)`, ref: { type: 'email_message', id: proposal.email_message_id }, detail: { office_action_id: proposal.id } }, actor)
  if (m.status === 'proposing') return proposal ? { ...stepFor(proposal, 'Scheduling'), ...(proposal.status === 'cancelled' || proposal.status === 'failed' || proposal.status === 'rejected' ? { status: 'escalated' as const } : {}) } : null
  if (m.status === 'proposed') {
    const sentAt = new Date(proposal?.executed_at ?? m.updated_at)
    const giveUp = new Date(sentAt.getTime() + 7 * 864e5)
    if (now.getTime() >= giveUp.getTime()) return { status: 'escalated', reason: `Scheduling: three times were proposed to ${m.contact_email} a week ago and none was picked`, nextAction: 'Follow up yourself or close the case.', nextCheckAt: null }
    return { status: 'waiting_external', reason: `Scheduling: three times proposed to ${m.contact_email}; waiting for them to pick one`, nextAction: null, nextCheckAt: new Date(Math.min(giveUp.getTime(), now.getTime() + 864e5)) }
  }
  if (m.status === 'booking') return event ? stepFor(event, 'Booking the meeting') : null
  if (m.status === 'booked') {
    if (event?.status === 'succeeded') await ensureActionRecorded(c.id, { summary: `Booked the meeting on Google Calendar with ${m.contact_email}`, ref: { type: 'calendar_event', id: m.calendar_event_id ?? event.external_id ?? event.id }, detail: { office_action_id: event.id, approval: event.approval_kind } }, actor)
    await moveCase(c.id, { status: 'verifying', reason: 'Reading the event back from Google Calendar' }, actor)
    const r = await readBackMeeting(m, now)
    if (r.ok) {
      await admin(db => resolveCase(db, c.id, { actor, verifiedBy: 'Google Calendar (fresh read of the event)', summary: `Meeting booked with ${m.contact_email}: ${r.start.slice(0, 16).replace('T', ' ')} UTC, confirmed on the calendar`, evidence: [r.evidence] }))
      return null
    }
    return r.retry ? { status: 'verifying', reason: `The booking could not be read back yet (${r.reason}); checking again`, nextCheckAt: new Date(now.getTime() + 3600e3) }
      : { status: 'escalated', reason: `The booking is not confirmed on the calendar: ${r.reason}`, nextAction: 'Check the calendar and rebook if needed.', nextCheckAt: null }
  }
  return { status: 'escalated', reason: `Scheduling ${m.status}${m.status_reason ? `: ${m.status_reason}` : ''}`, nextAction: 'Propose times yourself or close the case.', nextCheckAt: null }
}

/** A meeting counts only when Google Calendar returns the event, not cancelled, with the guest on it. */
export async function readBackMeeting(m: Pick<Meeting, 'org_id' | 'agent_id' | 'calendar_event_id' | 'contact_email'>, now: Date): Promise<{ ok: true; evidence: Evidence; start: string } | { ok: false; reason: string; retry: boolean }> {
  if (!m.calendar_event_id) return { ok: false, reason: 'no calendar event was recorded', retry: false }
  const ctx = await admin(db => agentCtx(db, m.agent_id))
  const cc = await conn(m.org_id, ctx?.policy?.calendarConnectionId)
  if (!cc) return { ok: false, reason: 'Google Calendar is not connected', retry: true }
  let ev
  try { ev = await calendarFor(cc).getEvent(m.calendar_event_id) } catch { return { ok: false, reason: 'Google Calendar did not answer', retry: true } }
  if (!ev || ev.status === 'cancelled') return { ok: false, reason: 'the event is not on the calendar (missing or cancelled)', retry: false }
  const guest = m.contact_email.toLowerCase()
  if (!ev.attendees.map(a => a.toLowerCase()).includes(guest)) return { ok: false, reason: `${guest} is not a guest of the event`, retry: false }
  return { ok: true, start: ev.start, evidence: { label: `Google Calendar: event "${ev.summary}" ${ev.start.slice(0, 16).replace('T', ' ')}–${ev.end.slice(11, 16)} UTC, ${ev.status}, with ${guest} as a guest`, source: 'google_calendar', observedAt: now.toISOString(),
    ref: { type: 'calendar_event', id: ev.id }, detail: { status: ev.status, start: ev.start, end: ev.end, attendees: ev.attendees } } }
}

/** A meeting the scheduler handles outside any lead case (someone asked to meet): its own meeting_request case. */
export async function syncMeetingCase(meetingId: string, now: Date): Promise<CaseRow | null> {
  const m = await admin(db => db.one<Meeting>('select * from office_meetings where id = $1', [meetingId]))
  if (!m) return null
  if (m.lead_id) {
    const lc = await admin(db => caseForRecord(db, m.org_id, 'office_lead', m.lead_id!))
    if (lc) return syncLeadCase(m.lead_id, now)
  }
  const ctx = await admin(db => agentCtx(db, m.agent_id))
  const actor = actorOf(ctx)
  let c = await admin(db => caseForRecord(db, m.org_id, 'office_meeting', m.id))
  if (!c) c = (await admin(db => openCase(db, {
    orgId: m.org_id, suite: 'office', kind: 'meeting_request', sourceApp: 'hubspot', dedupeKey: `meeting_request:${m.hubspot_contact_id ? `hubspot:${m.hubspot_contact_id}` : `email:${m.contact_email.toLowerCase()}`}`,
    title: `Meeting request from ${m.contact_email}`, problem: `${m.contact_email} asked to meet; three times are proposed and the one they pick is booked.`, whyItMatters: 'Someone who asked to meet and hears nothing goes elsewhere.',
    agent: { kind: 'office', ref: m.agent_id }, records: [{ type: 'office_meeting', id: m.id, label: m.contact_email }, ...(m.hubspot_contact_id ? [{ type: 'hubspot_contact', id: m.hubspot_contact_id }] : [])],
    evidence: [{ label: `Meeting request from ${m.contact_email}`, source: 'deploi_email', observedAt: iso(m.created_at), ref: { type: 'office_meeting', id: m.id } }],
    verification: { criteria: 'Resolved only when the booked event is read back from Google Calendar, not cancelled, with the requester as a guest.', rule: { kind: 'meeting_request', meeting: 'calendar event read back with the requester as attendee' } }, actor,
  }))).case
  if (TERMINAL.includes(c.status)) return c
  const stop = await stopped(m.org_id)
  if (stop) { await blockForStop(m.org_id, stop, { caseId: c.id }); return c }
  const t = await meetingStep(c, m, now, actor)
  if (t) await moveCase(c.id, t, actor)
  return admin(db => db.one<CaseRow>('select * from cases where id = $1', [c!.id]))
}

// ---------------------------------------------------------------- CRM commitments (stage rules)

async function contactOfRuleAction(a: OfficeActionRow): Promise<string | null> {
  if (a.payload.type === 'contact_update') return a.payload.contactId
  const ref = /^crmrule:[^:]+:[a-z_]+:([0-9a-f-]{36}):deal:/.exec(a.idempotency_key)?.[1]
  if (!ref) return null
  const r = await admin(db => db.one<{ c: string | null }>(`select coalesce((select hubspot_contact_id from office_leads where id = $1),
    (select coalesce(m.hubspot_contact_id, l.hubspot_contact_id) from office_meetings m left join office_leads l on l.id = m.lead_id where m.id = $1)) as c`, [ref]))
  return r?.c ?? null
}

/** A CRM Updater rule action (a lifecycle or deal stage change): its crm_commitment case, opened or found. */
async function crmCaseFor(a: OfficeActionRow): Promise<CaseRow | null> {
  const linked = await admin(db => caseForRecord(db, a.org_id, 'office_action', a.id))
  if (linked) return linked
  const contact = await contactOfRuleAction(a)
  if (!contact) return null
  const ctx = await admin(db => agentCtx(db, a.agent_id))
  const actor = actorOf(ctx)
  const email = await admin(db => db.one<{ email: string }>('select email from office_leads where org_id = $1 and hubspot_contact_id = $2 limit 1', [a.org_id, contact]))
  const c = (await admin(db => openCase(db, {
    orgId: a.org_id, suite: 'office', kind: 'crm_commitment', sourceApp: 'hubspot', dedupeKey: `crm_commitment:hubspot:${contact}`,
    title: `Update HubSpot for ${email?.email ?? `contact ${contact}`}`, problem: `A CRM rule calls for a stage change on HubSpot contact ${contact}.`, whyItMatters: 'A CRM that does not show what happened misleads the whole team.',
    agent: { kind: 'office', ref: a.agent_id }, records: [{ type: 'hubspot_contact', id: contact }],
    verification: { criteria: 'Resolved only when the HubSpot contact (or deal) is read back with the new stage.', rule: { kind: 'crm_commitment', verify: 'HubSpot record re-read' } }, actor,
  }))).case
  await ensureLink(c.id, { type: 'office_action', id: a.id, label: a.purpose }, actor)
  return c
}

export async function syncCrmCase(caseId: string, now: Date) {
  const c = await admin(db => db.one<CaseRow>('select * from cases where id = $1', [caseId]))
  if (!c || TERMINAL.includes(c.status)) return
  const stop = await stopped(c.org_id)
  if (stop) { await blockForStop(c.org_id, stop, { caseId }); return }
  const acts = await admin(db => db.query<OfficeActionRow>(`select a.* from office_actions a join case_links l on l.ref_type = 'office_action' and l.ref_id = a.id::text where l.case_id = $1 order by a.created_at`, [c.id]))
  if (!acts.length) return
  const actor = actorOf(await admin(db => agentCtx(db, acts[0].agent_id)))
  const pending = acts.find(a => !['succeeded'].includes(a.status))
  if (pending) {
    const t = stepFor(pending, 'CRM update')
    await moveCase(c.id, ['cancelled', 'failed', 'rejected'].includes(pending.status) ? { ...t, status: 'escalated' } : t, actor)
    return
  }
  for (const a of acts) await ensureActionRecorded(c.id, { summary: a.purpose, ref: { type: 'crm_change', id: a.id }, detail: { office_action_id: a.id, external_id: a.external_id } }, actor)
  await moveCase(c.id, { status: 'verifying', reason: 'Reading the records back from HubSpot' }, actor)
  const ctx = await admin(db => agentCtx(db, acts[0].agent_id))
  const hc = await conn(c.org_id, ctx?.policy?.hubspotConnectionId)
  if (!hc) { await moveCase(c.id, { status: 'verifying', reason: 'HubSpot is not connected; checking again later', nextCheckAt: new Date(now.getTime() + 3600e3) }, actor); return }
  const hs = hubspotFor(hc)
  const evidence: Evidence[] = []
  try {
    for (const a of acts) {
      if (a.payload.type === 'contact_update') {
        const fresh = await hs.getContact(a.payload.contactId)
        const want = a.payload.properties.lifecyclestage
        if (!fresh || (want !== undefined && fresh.lifecycleStage !== want)) { await moveCase(c.id, { status: 'escalated', reason: `HubSpot does not show the change on contact ${a.payload.contactId} (stage "${fresh?.lifecycleStage ?? 'missing'}")`, nextAction: 'Check the contact in HubSpot.', nextCheckAt: null }, actor); return }
        evidence.push({ label: `HubSpot contact ${fresh.id}: lifecycle stage "${fresh.lifecycleStage}"`, source: 'hubspot', observedAt: now.toISOString(), ref: { type: 'hubspot_contact', id: fresh.id }, detail: { lifecycleStage: fresh.lifecycleStage } })
      } else if (a.payload.type === 'deal_stage') {
        const fresh = await hs.getDeal(a.payload.dealId)
        if (fresh?.stage !== a.payload.stage) { await moveCase(c.id, { status: 'escalated', reason: `HubSpot does not show deal ${a.payload.dealId} at stage "${a.payload.stage}"`, nextAction: 'Check the deal in HubSpot.', nextCheckAt: null }, actor); return }
        evidence.push({ label: `HubSpot deal ${fresh.id}: stage "${fresh.stage}"`, source: 'hubspot', observedAt: now.toISOString(), ref: { type: 'hubspot_deal', id: fresh.id }, detail: { stage: fresh.stage } })
      }
    }
  } catch { await moveCase(c.id, { status: 'verifying', reason: 'HubSpot did not answer; checking again later', nextCheckAt: new Date(now.getTime() + 3600e3) }, actor); return }
  if (evidence.length) await admin(db => resolveCase(db, c.id, { actor, verifiedBy: 'HubSpot (fresh read of the records)', summary: evidence.map(e => e.label).join('; ').slice(0, 900), evidence }))
}

/** The CRM Updater's part of a lead case handed to it: one note with the reply outcome, under its own CRM tier. */
export async function proposeCaseCrmNotes(ctx: AgentCtx, now: Date, counts: Record<string, number>) {
  const rows = await admin(db => db.query<{ id: string; ref: string; lead_id: string; evidence: Evidence[] }>(`select c.id, c.ref, l.ref_id as lead_id, c.evidence from cases c join case_links l on l.case_id = c.id and l.ref_type = 'office_lead'
    where c.kind = 'lead_followup' and c.agent_kind = 'office' and c.agent_ref = $1 and c.status not in ('resolved','cancelled','blocked')
      and not exists (select 1 from office_actions a where a.org_id = c.org_id and a.idempotency_key = 'case:' || c.id::text || ':crm_outcome') limit 25`, [ctx.agent.id]))
  for (const r of rows) {
    const cls = [...r.evidence].reverse().map(e => (e.detail as { classification?: string } | undefined)?.classification).find(x => x === 'not_interested' || x === 'opt_out')
    if (!cls) continue
    const lead = await admin(db => db.one<Lead>('select * from office_leads where id = $1', [r.lead_id]))
    if (!lead) continue
    const key = `case:${r.id}:crm_outcome`
    const marker = crmMarker(`${ctx.agent.org_id}:${key}`, sha)
    const body = `Deploi Office: ${lead.email} replied ${cls === 'opt_out' ? 'asking not to be contacted again (opted out; the address is suppressed)' : 'that they are not interested'}. Case ${r.ref}. Ref ${marker}`
    const { action } = await admin(db => proposeAction(db, { agentId: ctx.agent.id, kind: 'crm_note', purpose: 'Record the lead\'s reply on the HubSpot contact', idempotencyKey: key, now,
      payload: { type: 'note', contactId: lead.hubspot_contact_id, body, marker } }))
    await ensureLink(r.id, { type: 'office_action', id: action.id, label: action.purpose }, actorOf(ctx))
    counts.case_notes = (counts.case_notes ?? 0) + 1
  }
}

// ---------------------------------------------------------------- org-wide sync, hooks, checkers

/** Bring every Office case of the organization (optionally of one agent's records) up to date with the records. */
export async function syncOfficeCases(orgId: string, now: Date, opts: { agentId?: string } = {}) {
  const stop = await stopped(orgId)
  if (stop) { await blockForStop(orgId, stop); return }
  const leads = await admin(db => db.query<{ id: string }>(`select l.id from office_leads l where l.org_id = $1 and ($2::uuid is null or l.agent_id = $2)
    and (l.status = 'active' or l.updated_at > $3::timestamptz - interval '30 days' or exists (select 1 from case_links k join cases c on c.id = k.case_id where k.ref_type = 'office_lead' and k.ref_id = l.id::text and c.status not in ('resolved','cancelled')))
    order by l.updated_at desc limit 200`, [orgId, opts.agentId ?? null, now.toISOString()]))
  for (const l of leads) await syncLeadCase(l.id, now)
  const meetings = await admin(db => db.query<{ id: string }>(`select id from office_meetings where org_id = $1 and ($2::uuid is null or agent_id = $2) and updated_at > $3::timestamptz - interval '30 days' order by updated_at desc limit 100`, [orgId, opts.agentId ?? null, now.toISOString()]))
  for (const m of meetings) await syncMeetingCase(m.id, now)
  const rules = await admin(db => db.query<OfficeActionRow>(`select * from office_actions where org_id = $1 and ($2::uuid is null or agent_id = $2) and kind in ('crm_update_contact','crm_deal_stage') and idempotency_key like 'crmrule:%'
    and created_at > $3::timestamptz - interval '30 days' order by created_at limit 200`, [orgId, opts.agentId ?? null, now.toISOString()]))
  const crmCases = new Set<string>()
  for (const a of rules) { const c = await crmCaseFor(a); if (c && !TERMINAL.includes(c.status)) crmCases.add(c.id) }
  for (const id of crmCases) await syncCrmCase(id, now)
  await syncEmailCases(orgId, now, opts)
}

/** The case of one Office action, brought up to date (the hook every settled action calls). */
export async function syncCaseForAction(actionId: string, now: Date) {
  const a = await admin(db => db.one<OfficeActionRow>('select * from office_actions where id = $1', [actionId]))
  if (!a) return
  if (a.lead_id) { await syncLeadCase(a.lead_id, now); return }
  if (a.meeting_id) { await syncMeetingCase(a.meeting_id, now); return }
  const caseKey = /^case:([0-9a-f-]{36}):crm_outcome$/.exec(a.idempotency_key)?.[1]
  if (caseKey) {
    const lead = await admin(db => db.one<{ ref_id: string }>(`select ref_id from case_links where case_id = $1 and ref_type = 'office_lead' limit 1`, [caseKey]))
    if (lead) await syncLeadCase(lead.ref_id, now)
    return
  }
  if ((a.kind === 'crm_update_contact' || a.kind === 'crm_deal_stage') && a.idempotency_key.startsWith('crmrule:')) { const c = await crmCaseFor(a); if (c) await syncCrmCase(c.id, now); return }
  const linked = await admin(db => caseForRecord(db, a.org_id, 'office_action', a.id))
  if (linked?.kind === 'email_unanswered') await syncEmailCase(linked.id, now)
}

onOfficeActionSettled(syncCaseForAction)

const recordOf = (c: CaseRow, type: string) => admin(db => db.one<{ ref_id: string }>('select ref_id from case_links where case_id = $1 and ref_type = $2 order by created_at limit 1', [c.id, type])).then(r => r?.ref_id ?? null)

// durable checks: a fresh look at the sources, then the case follows (lib/cases/jobs.ts runs them)
registerCaseKind('lead_followup', async (c, now) => {
  const stop = await stopped(c.org_id)
  if (stop) { await blockForStop(c.org_id, stop, { caseId: c.id }); return }
  const leadId = await recordOf(c, 'office_lead')
  if (leadId) await syncLeadCase(leadId, now, { fresh: true })
})
registerCaseKind('meeting_request', async (c, now) => { const id = await recordOf(c, 'office_meeting'); if (id) await syncMeetingCase(id, now) })
registerCaseKind('crm_commitment', async (c, now) => { await syncCrmCase(c.id, now) })

// ---------------------------------------------------------------- the owner closes a case with evidence

/**
 * The owner marks an Office case handled. Evidence is required: the id of a reply message Deploi recorded
 * (accepted by the provider), or the owner's own confirmation, which is recorded as exactly that.
 */
export async function markOfficeCaseHandled(actor: Actor, caseIdOrRef: string, input: { note: string; messageId?: string | null; now?: Date }) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not close a customer\'s cases')
  const note = String(input.note ?? '').trim()
  if (note.length < 3 || note.length > 500) throw new EngineError('invalid_input', 'say in a few words how it was handled (3 to 500 characters)')
  const now = input.now ?? new Date()
  return admin(async db => {
    const c = await db.one<CaseRow>(`select * from cases where (id::text = $1 or ref = $1) for update`, [caseIdOrRef])
    if (!c || c.suite !== 'office') throw new EngineError('not_found', 'case not found')
    assertMerchant(actor, c.org_id)
    const evidence: Evidence[] = [{ label: `Marked handled by ${actor.label}: ${note}`, source: 'owner', observedAt: now.toISOString() }]
    let verifiedBy = `${actor.label} (the owner's confirmation)`
    if (input.messageId) {
      const m = await db.one<{ id: string; status: string; accepted_at: string | null; to_addresses: string[] }>(`select id, status, accepted_at, to_addresses from email_messages where id = $1 and org_id = $2`, [input.messageId, c.org_id])
      if (!m || m.status !== 'accepted') throw new EngineError('invalid_input', 'that message was not accepted by the provider, so it cannot be the evidence')
      evidence.unshift({ label: `Reply to ${m.to_addresses.join(', ')} accepted by the provider ${m.accepted_at ? iso(m.accepted_at).slice(0, 16).replace('T', ' ') + ' UTC' : ''}`.trim(), source: 'deploi_email', observedAt: m.accepted_at ? iso(m.accepted_at) : now.toISOString(), ref: { type: 'email_message', id: m.id } })
      verifiedBy = 'the email engine record of the reply, confirmed by the owner'
    }
    return resolveCase(db, c.id, { actor: actor.label, summary: `Handled: ${note}`, verifiedBy, evidence })
  })
}

export { RESOLUTION_ACTOR }
