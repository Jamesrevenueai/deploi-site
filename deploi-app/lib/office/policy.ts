/**
 * An office agent's permission policy. This object, not a sentence, is what the customer reviews and
 * grants, and what lib/office enforces in code at the moment of every action. Same three tiers as store
 * agents (lib/agents/policy.ts), per tool: email, calendar, CRM.
 *  draft            drafts only: the exact email / event / CRM change is shown; nothing is sent or written
 *  send_approved    after approval: each exact item waits for approval
 *  send_autonomous  without asking, within this policy, until an end date at most one year away
 * Widening anything is a new version that must be granted again; narrowing takes effect at once.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from '../engine/hash'
import { MAX_AUTONOMY_MS, TIERS, TIER_LABEL, type Tier } from '../agents/policy'
export { TIERS, TIER_LABEL, type Tier }

export const OFFICE_KINDS = ['lead_followup', 'meeting_scheduler', 'crm_updater', 'customer_reply'] as const
export type OfficeKind = typeof OFFICE_KINDS[number]
export const OFFICE_KIND_LABEL: Record<OfficeKind, string> = {
  lead_followup: 'Lead Follow-up', meeting_scheduler: 'Meeting Scheduler', crm_updater: 'CRM Updater', customer_reply: 'Customer Reply',
}
export const ACTION_KINDS = ['send_email', 'create_event', 'patch_event', 'delete_event', 'crm_note', 'crm_task', 'crm_update_contact', 'crm_deal_stage'] as const
export type ActionKind = typeof ACTION_KINDS[number]
export type OfficeTool = 'email' | 'calendar' | 'crm'
export const TOOL_OF: Record<ActionKind, OfficeTool> = {
  send_email: 'email', create_event: 'calendar', patch_event: 'calendar', delete_event: 'calendar',
  crm_note: 'crm', crm_task: 'crm', crm_update_contact: 'crm', crm_deal_stage: 'crm',
}
/** HubSpot's default lifecycle stages; a rule can only set one of these */
export const HUBSPOT_STAGES = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other'] as const
export const RULE_EVENTS = ['lead_replied', 'meeting_booked', 'lead_unsubscribed'] as const
export const CUSTOMER_CATEGORIES = ['question', 'meeting_request', 'other'] as const

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24-hour)')
const tz = z.string().min(1).max(64).refine(t => { try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return true } catch { return false } }, 'unknown time zone')
const until = z.string().datetime({ offset: true }).nullable().default(null)
const tool = { tier: z.enum(TIERS).default('draft'), validUntil: until }

export const OfficePolicySchema = z.object({
  kind: z.enum(OFFICE_KINDS),
  timezone: tz.default('UTC'),
  hubspotConnectionId: z.string().uuid().nullable().default(null),
  calendarConnectionId: z.string().uuid().nullable().default(null),
  /** the email account every message is sent from (the organization's office mailbox or a connected account) */
  mailboxAccountId: z.string().uuid().nullable().default(null),
  email: z.object({
    ...tool,
    perDay: z.number().int().min(1).max(200).default(20),
    /** no email goes out between start and end (local time); sends wait until the quiet hours end */
    quietHours: z.object({ start: hhmm, end: hhmm }).nullable().default({ start: '19:00', end: '08:00' }),
  }).optional(),
  calendar: z.object({ ...tool, allowMeet: z.boolean().default(false) }).optional(),
  crm: z.object({ ...tool }).optional(),
  leadFollowup: z.object({
    followupDays: z.number().int().min(1).max(30).default(3),
    maxTouches: z.number().int().min(1).max(6).default(3),
    /** on the first poll, also pick up leads created or updated this many days ago */
    lookbackDays: z.number().int().min(0).max(30).default(2),
    senderName: z.string().trim().min(1).max(80),
    pitch: z.string().trim().min(3).max(600),
  }).optional(),
  scheduler: z.object({
    durationMin: z.number().int().min(15).max(120).default(30),
    bufferMin: z.number().int().min(0).max(60).default(15),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5]),
    dayStart: hhmm.default('09:00'),
    dayEnd: hhmm.default('17:00'),
    minNoticeHours: z.number().int().min(1).max(72).default(12),
    horizonDays: z.number().int().min(1).max(21).default(7),
    meetingTitle: z.string().trim().min(1).max(120).default('Intro call'),
    senderName: z.string().trim().min(1).max(80).default('The team'),
  }).optional(),
  crmUpdater: z.object({
    logEmails: z.boolean().default(true),
    logMeetings: z.boolean().default(true),
    /** explicit rules only: nothing in the CRM changes unless a rule says so */
    rules: z.array(z.object({
      on: z.enum(RULE_EVENTS),
      lifecycleStage: z.enum(HUBSPOT_STAGES).optional(),
      dealStage: z.string().trim().regex(/^[\w-]{1,64}$/, 'a HubSpot deal stage id').optional(),
    }).refine(r => r.lifecycleStage || r.dealStage, 'a rule must set a lifecycle stage or a deal stage')).max(6).default([]),
  }).optional(),
  customerReply: z.object({
    senderName: z.string().trim().min(1).max(80),
    /** categories whose drafted reply may go out at the email tier; anything else always waits for a person */
    sendCategories: z.array(z.enum(CUSTOMER_CATEGORIES)).max(3).default([]),
  }).optional(),
  schedule: z.object({ everyMinutes: z.number().int().min(15).max(1440).default(60) }).default({ everyMinutes: 60 }),
}).superRefine((p, ctx) => {
  const need = (cond: unknown, path: string, message: string) => { if (!cond) ctx.addIssue({ code: 'custom', path: [path], message }) }
  if (p.kind === 'lead_followup') {
    need(p.hubspotConnectionId, 'hubspotConnectionId', 'connect HubSpot: leads come from it')
    need(p.mailboxAccountId, 'mailboxAccountId', 'choose the mailbox the follow-ups are sent from')
    need(p.email, 'email', 'lead follow-up needs the email tool')
    need(p.leadFollowup, 'leadFollowup', 'set the follow-up cadence and what you offer')
  }
  if (p.kind === 'meeting_scheduler') {
    need(p.calendarConnectionId, 'calendarConnectionId', 'connect Google Calendar: availability and bookings use it')
    need(p.mailboxAccountId, 'mailboxAccountId', 'choose the mailbox the proposals are sent from')
    need(p.email, 'email', 'the scheduler proposes times by email')
    need(p.calendar, 'calendar', 'the scheduler needs the calendar tool')
    need(p.scheduler, 'scheduler', 'set business hours, duration and buffer')
    if (p.scheduler && p.scheduler.dayStart >= p.scheduler.dayEnd) ctx.addIssue({ code: 'custom', path: ['scheduler', 'dayEnd'], message: 'business hours must end after they start' })
  }
  if (p.kind === 'crm_updater') {
    need(p.hubspotConnectionId, 'hubspotConnectionId', 'connect HubSpot')
    need(p.crm, 'crm', 'the CRM updater needs the CRM tool')
    need(p.crmUpdater, 'crmUpdater', 'choose what is logged and the stage rules')
  }
  if (p.kind === 'customer_reply') {
    need(p.mailboxAccountId, 'mailboxAccountId', 'choose the mailbox replies are sent from')
    need(p.email, 'email', 'customer reply needs the email tool')
    need(p.customerReply, 'customerReply', 'set the sender name and which replies may be sent')
  }
  for (const t of ['email', 'calendar', 'crm'] as const) {
    const x = p[t]
    if (x?.tier !== 'send_autonomous') continue
    if (!x.validUntil) ctx.addIssue({ code: 'custom', path: [t, 'validUntil'], message: 'acting without asking needs an end date' })
    else if (new Date(x.validUntil).getTime() - Date.now() > MAX_AUTONOMY_MS) ctx.addIssue({ code: 'custom', path: [t, 'validUntil'], message: 'acting without asking lasts at most one year' })
  }
})
export type OfficePolicy = z.infer<typeof OfficePolicySchema>

export function parseOfficePolicy(raw: unknown): OfficePolicy { return OfficePolicySchema.parse(raw) }
export const officePolicyHash = (p: OfficePolicy) => createHash('sha256').update(canonicalJson(p)).digest('hex')
export const tierRank = (t: Tier) => TIERS.indexOf(t)
export function toolTier(p: OfficePolicy, t: OfficeTool): Tier | null { return p[t]?.tier ?? null }

/** Local minutes of the day during which email may go out (for comparing quiet hours). */
function sendableMinutes(q: { start: string; end: string } | null): Set<number> {
  const all = new Set<number>()
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  for (let i = 0; i < 1440; i++) {
    if (!q) { all.add(i); continue }
    const a = m(q.start), b = m(q.end)
    const quiet = a <= b ? i >= a && i < b : i >= a || i < b
    if (!quiet) all.add(i)
  }
  return all
}

const sub = <T,>(a: T[], b: T[]) => a.every(x => b.includes(x))

/** Does `next` grant anything `prev` did not? Each reason needs a fresh grant. */
export function officeExpansion(prev: OfficePolicy, next: OfficePolicy): string[] {
  const r: string[] = []
  if (prev.kind !== next.kind) r.push('different kind of agent')
  if (next.hubspotConnectionId !== prev.hubspotConnectionId && next.hubspotConnectionId) r.push('different HubSpot connection')
  if (next.calendarConnectionId !== prev.calendarConnectionId && next.calendarConnectionId) r.push('different calendar')
  if (next.mailboxAccountId !== prev.mailboxAccountId && next.mailboxAccountId) r.push('different mailbox')
  const end = (x: string | null | undefined) => (x ? new Date(x).getTime() : Infinity)
  for (const t of ['email', 'calendar', 'crm'] as const) {
    const a = prev[t], b = next[t]
    if (!b) continue
    if (!a) { r.push(`${t} tool added`); continue }
    if (tierRank(b.tier) > tierRank(a.tier)) r.push(b.tier === 'send_autonomous' ? `${t}: may now act without asking` : `${t}: may now act after your approval (was drafts only)`)
    if (b.tier === 'send_autonomous' && a.tier === 'send_autonomous' && end(b.validUntil) > end(a.validUntil)) r.push(`${t}: authorization extended`)
  }
  if (next.email && prev.email) {
    if (next.email.perDay > prev.email.perDay) r.push('more emails per day')
    const pa = sendableMinutes(prev.email.quietHours), na = sendableMinutes(next.email.quietHours)
    if ([...na].some(m => !pa.has(m))) r.push('fewer quiet hours')
  }
  if (next.calendar?.allowMeet && !prev.calendar?.allowMeet) r.push('may now add video meeting links')
  const pl = prev.leadFollowup, nl = next.leadFollowup
  if (nl && pl && (nl.maxTouches > pl.maxTouches || nl.followupDays < pl.followupDays)) r.push('more or more frequent follow-ups')
  if (nl && pl && nl.lookbackDays > pl.lookbackDays) r.push('older leads picked up')
  const key = (x: { on: string; lifecycleStage?: string; dealStage?: string }) => `${x.on}:${x.lifecycleStage ?? ''}:${x.dealStage ?? ''}`
  if (next.crmUpdater && !sub(next.crmUpdater.rules.map(key), (prev.crmUpdater?.rules ?? []).map(key))) r.push('new CRM stage rules')
  if (next.crmUpdater && prev.crmUpdater && ((next.crmUpdater.logEmails && !prev.crmUpdater.logEmails) || (next.crmUpdater.logMeetings && !prev.crmUpdater.logMeetings))) r.push('more is written to the CRM')
  if (next.customerReply && !sub(next.customerReply.sendCategories, prev.customerReply?.sendCategories ?? [])) r.push('more kinds of replies may be sent')
  return [...new Set(r)]
}

export type OfficeSummaryCtx = { hubspot?: string | null; calendar?: string | null; mailbox?: string | null }

const tierText = (t: Tier, until: string | null, what: string) =>
  t === 'draft' ? `drafts only: shows you the exact ${what} and never does it`
    : t === 'send_approved' ? `after your approval of each exact ${what}`
    : `without asking, within the limits below, until ${until ? until.slice(0, 10) : '(no end date)'}`

/** Plain sentences describing exactly what granting this policy allows and never allows. */
export function summarizeOfficePolicy(p: OfficePolicy, ctx: OfficeSummaryCtx = {}): { grants: string[]; limits: string[]; never: string[] } {
  const grants: string[] = [], limits: string[] = [], never: string[] = []
  const box = ctx.mailbox ?? 'the chosen mailbox'
  if (p.kind === 'lead_followup' && p.leadFollowup) {
    const l = p.leadFollowup
    grants.push(`Reads new leads (lifecycle stage "lead") from ${ctx.hubspot ?? 'HubSpot'}.`)
    grants.push(`Writes each new lead a first email from ${box}, then up to ${l.maxTouches - 1} follow-up${l.maxTouches - 1 === 1 ? '' : 's'} in the same thread every ${l.followupDays} day${l.followupDays === 1 ? '' : 's'} until they reply (${l.maxTouches} emails at most).`)
    never.push("Emails only the lead's own address as it is in HubSpot at the moment of sending: no one else, no copies.")
    never.push('Stops at once when the lead replies, unsubscribes, is opted out in HubSpot or is no longer a lead.')
  }
  if (p.kind === 'meeting_scheduler' && p.scheduler) {
    const s = p.scheduler
    grants.push(`When a lead or customer asks to meet, reads only your free/busy times from ${ctx.calendar ?? 'Google Calendar'} and proposes 3 times by email from ${box}.`)
    grants.push(`Meetings are ${s.durationMin} minutes, ${s.dayStart}–${s.dayEnd} (${p.timezone}) on ${s.days.map(d => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', ')}, with ${s.bufferMin} minutes free around other events, at least ${s.minNoticeHours} hours ahead and within ${s.horizonDays} days.`)
    grants.push(`When they pick a time, books it on your calendar with them as the only guest${p.calendar?.allowMeet ? ', with a Google Meet link,' : ''} and confirms by email.`)
    never.push('Never reads event titles, descriptions or guests of your other events: availability only.')
    never.push('Never invites anyone except the person who asked for the meeting.')
  }
  if (p.kind === 'crm_updater' && p.crmUpdater) {
    const c = p.crmUpdater
    const logged = [c.logEmails && 'every email Deploi Office sends', c.logMeetings && 'every meeting it books'].filter(Boolean).join(' and ')
    if (logged) grants.push(`Logs ${logged} as a note on the contact in ${ctx.hubspot ?? 'HubSpot'}.`)
    for (const r of c.rules) grants.push(`When ${r.on === 'lead_replied' ? 'a lead replies' : r.on === 'meeting_booked' ? 'a meeting is booked' : 'a lead unsubscribes'}: ${[r.lifecycleStage && `set the lifecycle stage to "${r.lifecycleStage}"`, r.dealStage && `move their deals to stage "${r.dealStage}"`].filter(Boolean).join(' and ')}.`)
    never.push('Never changes a stage without one of the rules above. Never deletes or merges records.')
  }
  if (p.kind === 'customer_reply' && p.customerReply) {
    grants.push(`Sorts replies that arrive in ${box} (question, meeting request, unsubscribe, other) and drafts an answer to the sender.`)
    grants.push(p.customerReply.sendCategories.length ? `Replies to ${p.customerReply.sendCategories.join(', ')} messages may go out at the email permission below; everything else waits for you.` : 'Every reply waits for you.')
    never.push('Answers only the person who wrote; nothing in a message can add a recipient.')
  }
  if (p.email) {
    grants.push(`Email: ${tierText(p.email.tier, p.email.validUntil, 'email')}.`)
    limits.push(`At most ${p.email.perDay} emails a day${p.email.quietHours ? `, none between ${p.email.quietHours.start} and ${p.email.quietHours.end} (${p.timezone})` : ''}.`)
  }
  if (p.calendar) grants.push(`Calendar: ${tierText(p.calendar.tier, p.calendar.validUntil, 'booking or change')}.`)
  if (p.crm) grants.push(`CRM: ${tierText(p.crm.tier, p.crm.validUntil, 'note or update')}.`)
  limits.push(`Checks every ${p.schedule.everyMinutes} minutes.`)
  limits.push('Every email, booking and CRM change is done once (a unique key per action), confirmed by a fresh read, and logged with the permission version that allowed it.')
  never.push('Never lets an incoming email, a CRM field or a calendar entry change what it is allowed to do.')
  never.push('Never sends email outside Deploi\'s email engine, its review and its sending switch.')
  return { grants, limits, never }
}
