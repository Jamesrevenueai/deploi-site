/**
 * Office actions. Every consequential thing an office agent does (send an email, create / change /
 * delete a calendar event, write to the CRM) is one office_actions row:
 *   proposed (Draft | Awaiting approval | Queued) -> Executing -> Succeeded | Failed | Unknown | Cancelled
 * - The row's idempotency key is unique per organization: the same lead touch, booking or CRM note can
 *   never be proposed, approved or executed twice, whatever retries or overlapping runs happen.
 * - An approval is bound to the payload hash: any edit clears it.
 * - The granted policy version is checked when the action is proposed, approved and again just before it
 *   is executed (agent active, tier, end date, recipients, quiet hours, daily cap, product enabled).
 * - Success means a fresh read shows the result. A lost answer is Unknown and is reconciled (looked up)
 *   before anything is retried: never a second email, a second event or a second note.
 * - Email goes through the existing email engine (lib/email/engine.ts) and its live-send gate.
 */
import { createHash, randomBytes } from 'node:crypto'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { admin, type Db } from '../db'
import { canonicalJson } from '../engine/hash'
import { EngineError } from '../engine/errors'
import { encryptSecret } from '../connectors/credentials'
import { orgStopReason } from '../engine/kill-switch'
import { allowanceBlock } from '../plans/allowance'
import { needsFirstReplyApproval } from '../email/sender-policy'
import { registerOfficeSendGate, sendMessage, type EmailMessageRow, type EmailStatus } from '../email/engine'
import { contentHash } from '../email/content'
import { newInternetMessageId } from '../email/mime'
import { emailConfig } from '../email/config'
import { hasProduct } from '../products'
import { officeAudit } from './audit'
import { OfficeHttpError } from './http'
import { OfficeAuthError } from './credentials'
import { calendarFor, hubspotFor } from './providers'
import type { OfficeConnectionRow } from './connections'
import { parseOfficePolicy, tierRank, TOOL_OF, type ActionKind, type OfficePolicy, type OfficeTool } from './policy'

export type ActionStatus = 'draft' | 'awaiting_approval' | 'queued' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'rejected'

/** Where the only allowed recipient of an email comes from: always a database record, never the message text. */
export type RecipientSource = { kind: 'lead'; leadId: string } | { kind: 'meeting'; meetingId: string } | { kind: 'inbound'; inboundId: string } | { kind: 'invoice'; invoiceId: string }

export type EmailPayload = { type: 'email'; to: string; subject: string; body: string; inReplyToMessageId: string | null; recipientSource: RecipientSource; meta: Record<string, unknown> }
export type EventPayload = { type: 'event'; eventId: string; summary: string; description: string; start: string; end: string; timeZone: string; attendees: string[]; meet: boolean; bufferMin: number }
export type EventPatchPayload = { type: 'event_patch'; eventId: string; start: string; end: string; timeZone: string }
export type EventDeletePayload = { type: 'event_delete'; eventId: string }
export type NotePayload = { type: 'note'; contactId: string; body: string; marker: string }
export type TaskPayload = { type: 'task'; contactId: string; subject: string; body: string; dueAt: string; marker: string }
export type ContactPayload = { type: 'contact_update'; contactId: string; properties: Record<string, string> }
export type DealPayload = { type: 'deal_stage'; dealId: string; stage: string }
export type ActionPayload = EmailPayload | EventPayload | EventPatchPayload | EventDeletePayload | NotePayload | TaskPayload | ContactPayload | DealPayload

export type OfficeActionRow = {
  id: string; org_id: string; agent_id: string; policy_id: string | null; policy_version: number | null; kind: ActionKind; purpose: string; idempotency_key: string
  status: ActionStatus; status_reason: string | null; payload: ActionPayload; payload_hash: string; approval_kind: 'individual' | 'standing' | null; approved_by: string | null
  approved_hash: string | null; approved_at: string | null; qualification: { covered: boolean; reasons: string[]; blockers: string[] } | null
  lead_id: string | null; meeting_id: string | null; email_message_id: string | null; external_id: string | null; result: Record<string, unknown> | null
  attempts: number; next_attempt_at: string | null; executing_started_at: string | null; executed_at: string | null; verified_at: string | null; created_at: string; updated_at: string
}

export type AgentRow = { id: string; org_id: string; kind: OfficePolicy['kind']; name: string; status: string; active_policy_id: string | null; next_run_at: string | null; last_run_at: string | null; last_polled_at: string | null; created_at: string }
export type AgentCtx = { agent: AgentRow; policyId: string | null; policyVersion: number; policyStatus: string; policy: OfficePolicy | null }

export const payloadHash = (p: ActionPayload) => createHash('sha256').update(canonicalJson(p)).digest('hex')
export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const MAX_ATTEMPTS = 4

export async function agentCtx(db: Db, agentId: string): Promise<AgentCtx | null> {
  const agent = await db.one<AgentRow>('select * from office_agents where id = $1', [agentId])
  if (!agent) return null
  const p = agent.active_policy_id ? await db.one<{ id: string; version: number; status: string; policy: unknown }>('select id, version, status, policy from office_agent_policies where id = $1', [agent.active_policy_id]) : null
  return { agent, policyId: p?.id ?? null, policyVersion: p?.version ?? 0, policyStatus: p?.status ?? 'none', policy: p ? parseOfficePolicy(p.policy) : null }
}

export const actorFor = (ctx: AgentCtx) => `office-agent:${ctx.agent.name.slice(0, 60)}@v${ctx.policyVersion}`

/** The only recipient an email may have, recomputed from the database (lead's HubSpot address, the person who asked for the meeting, the sender of the message we answer). */
export async function allowedRecipient(db: Db, orgId: string, src: RecipientSource): Promise<string | null> {
  if (src.kind === 'lead') return (await db.one<{ email: string }>(`select email from office_leads where id = $1 and org_id = $2`, [src.leadId, orgId]))?.email ?? null
  if (src.kind === 'meeting') return (await db.one<{ contact_email: string }>(`select contact_email from office_meetings where id = $1 and org_id = $2`, [src.meetingId, orgId]))?.contact_email ?? null
  // an invoice reminder: the invoice's billing address as last read from QuickBooks, only while reminders are allowed for it
  if (src.kind === 'invoice') return (await db.one<{ bill_email: string | null }>(`select bill_email from office_invoices where id = $1 and org_id = $2 and status = 'open'`, [src.invoiceId, orgId]))?.bill_email ?? null
  return (await db.one<{ from_address: string }>(`select from_address from email_inbound where id = $1 and org_id = $2 and status = 'accepted'`, [src.inboundId, orgId]))?.from_address ?? null
}

type Tool = NonNullable<OfficePolicy[OfficeTool]>

/** Base conditions for any execution of this action under the current policy (individually approved or not). */
async function baseBlockers(db: Db, ctx: AgentCtx, a: Pick<OfficeActionRow, 'kind' | 'payload' | 'org_id' | 'meeting_id'>): Promise<string[]> {
  const b: string[] = []
  if (ctx.agent.status !== 'active') b.push(`the agent is ${ctx.agent.status}`)
  if (!ctx.policy || ctx.policyStatus !== 'active') { b.push('the agent has no active authorization'); return b }
  const tool = ctx.policy[TOOL_OF[a.kind]] as Tool | undefined
  if (!tool) b.push(`the agent is not authorized to use the ${TOOL_OF[a.kind]} tool`)
  else if (tierRank(tool.tier) < tierRank('send_approved')) b.push(`${TOOL_OF[a.kind]}: this agent only drafts`)
  if (a.payload.type === 'email') {
    const allowed = await allowedRecipient(db, a.org_id, a.payload.recipientSource)
    if (!allowed || allowed.toLowerCase() !== a.payload.to.toLowerCase()) b.push(`the recipient ${a.payload.to} is not the allowed recipient for this message`)
  }
  if (a.payload.type === 'event') {
    const meetingEmail = a.meeting_id ? await db.one<{ contact_email: string }>('select contact_email from office_meetings where id = $1 and org_id = $2', [a.meeting_id, a.org_id]) : null
    const outside = a.payload.attendees.filter(x => x.toLowerCase() !== meetingEmail?.contact_email.toLowerCase())
    if (!meetingEmail || outside.length) b.push('a calendar event may invite only the person who asked for the meeting')
    if (a.payload.meet && !ctx.policy.calendar?.allowMeet) b.push('adding a video meeting link is not authorized')
  }
  return b
}

/** Standing authorization (without asking): may this exact action go ahead on its own? */
async function qualify(db: Db, ctx: AgentCtx, a: Pick<OfficeActionRow, 'kind' | 'payload' | 'org_id' | 'meeting_id'>, now: Date, extra: string[] = []) {
  const blockers = [...(await baseBlockers(db, ctx, a)), ...extra]
  const reasons: string[] = []
  const tool = ctx.policy?.[TOOL_OF[a.kind]] as Tool | undefined
  if (tool && tool.tier !== 'send_autonomous') blockers.push(`${TOOL_OF[a.kind]}: each item waits for your approval`)
  if (tool?.tier === 'send_autonomous') {
    if (!tool.validUntil || new Date(tool.validUntil).getTime() <= now.getTime()) blockers.push(`${TOOL_OF[a.kind]}: the authorization to act without asking ended${tool.validUntil ? ` on ${tool.validUntil.slice(0, 10)}` : ''}`)
    else reasons.push(`${TOOL_OF[a.kind]} may act without asking until ${tool.validUntil.slice(0, 10)}`)
  }
  if (!blockers.length) reasons.push(a.payload.type === 'email' ? 'the only recipient is the allowed recipient for this message' : 'within the granted scope', `authorization version ${ctx.policyVersion}`)
  return { covered: blockers.length === 0, reasons, blockers: [...new Set(blockers)] }
}

export type ProposeInput = {
  agentId: string; kind: ActionKind; purpose: string; idempotencyKey: string; payload: ActionPayload
  leadId?: string | null; meetingId?: string | null; actor?: string; now?: Date
  /** extra reasons this action may not go out on its own (it then waits for approval), e.g. a category that always needs a person */
  standingBlockers?: string[]
}

/**
 * Propose one action (service role, inside the caller's transaction). Duplicate keys return the existing row
 * unchanged, except a row that was cancelled before anything happened (pause, then resume), which is proposed again.
 */
export async function proposeAction(db: Db, i: ProposeInput): Promise<{ action: OfficeActionRow; duplicate: boolean }> {
  const now = i.now ?? new Date()
  const ctx = await agentCtx(db, i.agentId)
  if (!ctx || !ctx.policy || ctx.agent.status !== 'active') throw new EngineError('agent_inactive', 'the agent is not active')
  const hash = payloadHash(i.payload)
  let row = await db.one<OfficeActionRow>(`insert into office_actions (org_id, agent_id, policy_id, policy_version, kind, purpose, idempotency_key, status, payload, payload_hash, lead_id, meeting_id)
    values ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11) on conflict (org_id, idempotency_key) do nothing returning *`,
    [ctx.agent.org_id, ctx.agent.id, ctx.policyId, ctx.policyVersion, i.kind, i.purpose.slice(0, 200), i.idempotencyKey, JSON.stringify(i.payload), hash, i.leadId ?? null, i.meetingId ?? null])
  if (!row) {
    const existing = (await db.one<OfficeActionRow>('select * from office_actions where org_id = $1 and idempotency_key = $2 for update', [ctx.agent.org_id, i.idempotencyKey]))!
    const untouched = existing.status === 'cancelled' && !existing.executed_at && existing.attempts === 0
    if (!untouched) return { action: existing, duplicate: true }
    row = (await db.one<OfficeActionRow>(`update office_actions set policy_id = $2, policy_version = $3, payload = $4, payload_hash = $5, status = 'draft', status_reason = null, approval_kind = null,
      approved_by = null, approved_hash = null, approved_at = null, qualification = null, next_attempt_at = null where id = $1 returning *`, [existing.id, ctx.policyId, ctx.policyVersion, JSON.stringify(i.payload), hash]))!
  }
  const tool = ctx.policy[TOOL_OF[i.kind]] as Tool | undefined
  let status: ActionStatus, reason: string, q: Awaited<ReturnType<typeof qualify>> | null = null
  if (!tool || tool.tier === 'draft') { status = 'draft'; reason = `drafts only: this is exactly what the agent would do; nothing is ${i.kind === 'send_email' ? 'sent' : 'written'}` }
  else if (tool.tier === 'send_approved') {
    const b = await baseBlockers(db, ctx, row)
    status = b.length ? 'cancelled' : 'awaiting_approval'
    reason = b.length ? `refused: ${b.join('; ')}` : 'waiting for your approval of this exact item'
  } else {
    q = await qualify(db, ctx, row, now, i.standingBlockers ?? [])
    if (q.covered) { status = 'queued'; reason = 'covered by the standing authorization' }
    else {
      const hard = await baseBlockers(db, ctx, row)
      status = hard.length ? 'cancelled' : 'awaiting_approval'
      reason = hard.length ? `refused: ${hard.join('; ')}` : `waiting for your approval: ${q.blockers.join('; ')}`
    }
  }
  const standing = status === 'queued'
  row = (await db.one<OfficeActionRow>(`update office_actions set status = $2, status_reason = $3, qualification = $4, approval_kind = $5, approved_by = $6, approved_hash = $7, approved_at = $8 where id = $1 returning *`,
    [row.id, status, reason, q ? JSON.stringify(q) : null, standing ? 'standing' : null, standing ? actorFor(ctx) : null, standing ? hash : null, standing ? now.toISOString() : null]))!
  await officeAudit(db, { orgId: row.org_id, entityType: 'office_action', entityId: row.id, event: `action.${status}`, actor: i.actor ?? actorFor(ctx),
    detail: { kind: i.kind, purpose: i.purpose, agent_id: ctx.agent.id, policy_version: ctx.policyVersion, payload_hash: hash, idempotency_key: i.idempotencyKey, why: q?.reasons ?? [], blockers: q?.blockers ?? [] } })
  return { action: row, duplicate: false }
}

// ---------------------------------------------------------------- quiet hours and daily caps

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** When quiet hours (local) are in force at `now`, the time they end; otherwise null. */
export function quietUntil(q: { start: string; end: string } | null, tz: string, now: Date): Date | null {
  if (!q) return null
  const local = formatInTimeZone(now, tz, 'yyyy-MM-dd HH:mm')
  const [date, time] = local.split(' ')
  const t = minutes(time), a = minutes(q.start), b = minutes(q.end)
  const quiet = a <= b ? t >= a && t < b : t >= a || t < b
  if (!quiet) return null
  const endDate = a > b && t >= a ? new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : date
  return fromZonedTime(`${endDate}T${q.end}:00`, tz)
}

function nextLocalMidnight(tz: string, now: Date): Date {
  const date = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  return fromZonedTime(`${new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)}T00:00:00`, tz)
}

async function sentToday(db: Db, agentId: string, tz: string, now: Date): Promise<number> {
  const date = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  const start = fromZonedTime(`${date}T00:00:00`, tz)
  const r = await db.one<{ n: string }>(`select count(*)::text as n from office_actions where agent_id = $1 and kind = 'send_email' and status in ('executing','succeeded','unknown') and executing_started_at >= $2`, [agentId, start.toISOString()])
  return Number(r?.n ?? 0)
}

// ---------------------------------------------------------------- execution

type Claim =
  | { kind: 'skip'; status: ActionStatus; reason: string | null }
  | { kind: 'go'; a: OfficeActionRow; ctx: AgentCtx; conn: OfficeConnectionRow | null; actor: string }

async function connectionFor(db: Db, a: OfficeActionRow, p: OfficePolicy): Promise<OfficeConnectionRow | null> {
  const tool = TOOL_OF[a.kind]
  const id = tool === 'calendar' ? p.calendarConnectionId : tool === 'crm' ? p.hubspotConnectionId : p.hubspotConnectionId
  if (!id) return null
  return db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2`, [id, a.org_id])
}

async function setStatus(db: Db, a: OfficeActionRow, status: ActionStatus, reason: string | null, actor: string, extra: Record<string, unknown> = {}) {
  const sets = ['status = $2', 'status_reason = $3'], vals: unknown[] = [a.id, status, reason]
  for (const [k, v] of Object.entries(extra)) { vals.push(v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`) }
  const row = (await db.one<OfficeActionRow>(`update office_actions set ${sets.join(', ')} where id = $1 returning *`, vals))!
  await officeAudit(db, { orgId: a.org_id, entityType: 'office_action', entityId: a.id, event: `action.${status}`, actor,
    detail: { kind: a.kind, agent_id: a.agent_id, policy_version: row.policy_version, approval_kind: a.approval_kind, reason: reason?.slice(0, 300) ?? null, external_id: row.external_id } })
  return row
}

async function claim(actionId: string, now: Date, actorOverride?: string): Promise<Claim> {
  return admin(async db => {
    const owner = await db.one<{ agent_id: string }>('select agent_id from office_actions where id = $1', [actionId])
    if (!owner) throw new EngineError('not_found', 'action not found')
    // same lock order as pause and revoke: the agent row, then its actions
    await db.query('select id from office_agents where id = $1 for share', [owner.agent_id])
    const a = (await db.one<OfficeActionRow>('select * from office_actions where id = $1 for update', [actionId]))!
    if (a.status !== 'queued') return { kind: 'skip', status: a.status, reason: a.status_reason }
    if (a.next_attempt_at && new Date(a.next_attempt_at).getTime() > now.getTime()) return { kind: 'skip', status: a.status, reason: a.status_reason }
    const ctx = (await agentCtx(db, a.agent_id))!
    const actor = actorOverride ?? (a.approval_kind === 'individual' && a.approved_by ? a.approved_by : actorFor(ctx))
    const stop = async (status: ActionStatus, reason: string, extra: Record<string, unknown> = {}): Promise<Claim> => { await setStatus(db, a, status, reason, actor, extra); return { kind: 'skip', status, reason } }
    if (ctx.agent.status !== 'active') return stop('cancelled', `the agent is ${ctx.agent.status}; queued actions are not carried out`)
    const orgStopped = await orgStopReason(db, a.org_id)
    if (orgStopped) return stop('cancelled', `${orgStopped}; queued actions are not carried out`)
    if (!(await hasProduct(db, a.org_id, 'office'))) return stop('failed', 'Deploi Office is not enabled for this organization')
    if (!ctx.policy || ctx.policyStatus !== 'active') return stop('cancelled', 'the agent has no active authorization')
    if (a.approved_hash !== a.payload_hash) return stop('awaiting_approval', 'the item changed after approval; approve the new version', { approval_kind: null, approved_hash: null, approved_by: null, approved_at: null })
    if (a.approval_kind === 'standing') {
      const q = await qualify(db, ctx, a, now)
      if (!q.covered) {
        const hard = await baseBlockers(db, ctx, a)
        if (hard.length) return stop('cancelled', `no longer allowed: ${hard.join('; ')}`, { qualification: q })
        return stop('awaiting_approval', `no longer covered by the standing authorization: ${q.blockers.join('; ')}`, { qualification: q, approval_kind: null, approved_hash: null, approved_by: null, approved_at: null })
      }
    } else if (a.approval_kind === 'individual') {
      const b = await baseBlockers(db, ctx, a)
      if (b.length) return stop('cancelled', `cannot be carried out: ${b.join('; ')}`)
    } else return stop('awaiting_approval', 'waiting for your approval')
    // the month's action allowance (lib/plans/allowance.ts), counted under the organization's lock with this claim:
    // held for approval again (standing or individually approved), never dropped
    const held = await allowanceBlock(db, a.org_id, { now, lock: true })
    if (held) return stop('awaiting_approval', `held: ${held.reason}`, { approval_kind: null, approved_hash: null, approved_by: null, approved_at: null, next_attempt_at: null })
    if (a.kind === 'send_email' && ctx.policy.email) {
      const quiet = quietUntil(ctx.policy.email.quietHours, ctx.policy.timezone, now)
      if (quiet) { await db.query('update office_actions set next_attempt_at = $2, status_reason = $3 where id = $1', [a.id, quiet.toISOString(), `quiet hours: waits until ${formatInTimeZone(quiet, ctx.policy.timezone, 'HH:mm')} (${ctx.policy.timezone})`]); return { kind: 'skip', status: 'queued', reason: 'quiet hours' } }
      if ((await sentToday(db, ctx.agent.id, ctx.policy.timezone, now)) >= ctx.policy.email.perDay) {
        const next = nextLocalMidnight(ctx.policy.timezone, now)
        await db.query('update office_actions set next_attempt_at = $2, status_reason = $3 where id = $1', [a.id, next.toISOString(), `daily limit of ${ctx.policy.email.perDay} emails reached: waits until tomorrow`])
        return { kind: 'skip', status: 'queued', reason: 'daily limit' }
      }
    }
    let conn: OfficeConnectionRow | null = null
    if (a.kind !== 'send_email') {
      conn = await connectionFor(db, a, ctx.policy)
      if (!conn || conn.status !== 'active') return stop('failed', `${TOOL_OF[a.kind] === 'calendar' ? 'Google Calendar' : 'HubSpot'} is not connected`)
    } else if (ctx.policy.hubspotConnectionId) conn = await db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2`, [ctx.policy.hubspotConnectionId, a.org_id])
    if (a.attempts >= MAX_ATTEMPTS) return stop('failed', `gave up after ${a.attempts} attempts`)
    await db.query(`update office_actions set status = 'executing', status_reason = null, attempts = attempts + 1, executing_started_at = $2, policy_id = $3, policy_version = $4 where id = $1`,
      [a.id, now.toISOString(), ctx.policyId, ctx.policyVersion])
    await officeAudit(db, { orgId: a.org_id, entityType: 'office_action', entityId: a.id, event: 'action.executing', actor, detail: { kind: a.kind, attempt: a.attempts + 1, approval_kind: a.approval_kind, policy_version: ctx.policyVersion, why: a.qualification?.reasons ?? [] } })
    return { kind: 'go', a: { ...a, attempts: a.attempts + 1, policy_version: ctx.policyVersion }, ctx, conn, actor }
  })
}

type Outcome = { status: ActionStatus; reason: string | null; externalId?: string | null; result?: Record<string, unknown>; nextAttemptAt?: string | null; emailMessageId?: string | null; verified?: boolean }

const uncertain = (e: unknown) => e instanceof OfficeHttpError && e.uncertain
function failure(e: unknown, what: string): Outcome {
  if (e instanceof OfficeAuthError) return { status: 'failed', reason: `${what}: ${e.message}` }
  if (e instanceof OfficeHttpError) {
    if (e.uncertain) return { status: 'unknown', reason: `${what}: no definite answer from the provider; checking before any retry` }
    if (e.code === 'rate_limited') return { status: 'queued', reason: `${what}: the provider is rate limiting; trying again shortly`, nextAttemptAt: new Date(Date.now() + 60e3).toISOString() }
    return { status: 'failed', reason: `${what}: ${e.message}` }
  }
  return { status: 'failed', reason: `${what}: ${(e as Error).message?.slice(0, 200) ?? 'unexpected error'}` }
}

const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime()

async function performEvent(a: OfficeActionRow, conn: OfficeConnectionRow): Promise<Outcome> {
  const cal = calendarFor(conn)
  const p = a.payload
  try {
    if (p.type === 'event') {
      // a retry after an unknown outcome first looks for the event (its id is deterministic)
      let ev = a.attempts > 1 ? await cal.getEvent(p.eventId) : null
      if (!ev) {
        const busy = await cal.freeBusy({ timeMin: new Date(new Date(p.start).getTime() - p.bufferMin * 60e3).toISOString(), timeMax: new Date(new Date(p.end).getTime() + p.bufferMin * 60e3).toISOString(), timeZone: p.timeZone })
        if (busy.length) return { status: 'failed', reason: 'the chosen time is no longer free on the calendar; nothing was booked' }
        ev = await cal.insertEvent({ id: p.eventId, summary: p.summary, description: p.description, start: p.start, end: p.end, timeZone: p.timeZone, attendees: p.attendees, meet: p.meet, requestId: p.eventId })
      }
      const fresh = await cal.getEvent(p.eventId)
      if (!fresh || fresh.status === 'cancelled' || !sameInstant(fresh.start, p.start) || !sameInstant(fresh.end, p.end) || !p.attendees.every(x => fresh.attendees.includes(x.toLowerCase())))
        return { status: 'unknown', reason: 'the event could not be confirmed by a fresh read; checking again before any retry', externalId: p.eventId }
      return { status: 'succeeded', reason: null, externalId: fresh.id, verified: true, result: { meetLink: fresh.meetLink ?? ev.meetLink, htmlLink: fresh.htmlLink, start: fresh.start, end: fresh.end } }
    }
    if (p.type === 'event_patch') {
      await cal.patchEvent(p.eventId, { start: p.start, end: p.end, timeZone: p.timeZone })
      const fresh = await cal.getEvent(p.eventId)
      if (!fresh || !sameInstant(fresh.start, p.start) || !sameInstant(fresh.end, p.end)) return { status: 'unknown', reason: 'the change could not be confirmed by a fresh read', externalId: p.eventId }
      return { status: 'succeeded', reason: null, externalId: p.eventId, verified: true, result: { start: fresh.start, end: fresh.end } }
    }
    if (p.type === 'event_delete') {
      const r = await cal.deleteEvent(p.eventId)
      const fresh = await cal.getEvent(p.eventId)
      if (fresh && fresh.status !== 'cancelled') return { status: 'unknown', reason: 'the cancellation could not be confirmed by a fresh read', externalId: p.eventId }
      return { status: 'succeeded', reason: r === 'already_gone' ? 'the event was already cancelled' : null, externalId: p.eventId, verified: true }
    }
  } catch (e) { return { ...failure(e, 'calendar'), externalId: 'eventId' in p ? p.eventId : null } }
  return { status: 'failed', reason: 'not a calendar action' }
}

async function performCrm(a: OfficeActionRow, conn: OfficeConnectionRow): Promise<Outcome> {
  const hs = hubspotFor(conn)
  const p = a.payload
  try {
    if (p.type === 'note') {
      const found = a.attempts > 1 ? await hs.findNoteByMarker(p.marker) : null
      const id = found?.id ?? (await hs.createNote({ contactId: p.contactId, body: p.body, timestamp: new Date() })).id
      const fresh = await hs.getNote(id)
      if (!fresh || !fresh.body.includes(p.marker)) return { status: 'unknown', reason: 'the note could not be confirmed by a fresh read', externalId: id }
      return { status: 'succeeded', reason: null, externalId: id, verified: true }
    }
    if (p.type === 'task') {
      const found = a.attempts > 1 ? await hs.findTaskByMarker(p.marker) : null
      const id = found?.id ?? (await hs.createTask({ contactId: p.contactId, subject: p.subject, body: p.body, dueAt: new Date(p.dueAt) })).id
      const fresh = await hs.getTask(id)
      if (!fresh || !fresh.body.includes(p.marker)) return { status: 'unknown', reason: 'the task could not be confirmed by a fresh read', externalId: id }
      return { status: 'succeeded', reason: null, externalId: id, verified: true }
    }
    if (p.type === 'contact_update') {
      await hs.updateContact(p.contactId, p.properties)
      const fresh = await hs.getContact(p.contactId)
      const ok = fresh && Object.entries(p.properties).every(([k, v]) => (k === 'lifecyclestage' ? fresh.lifecycleStage === v : k === 'hs_email_optout' ? String(fresh.optedOut) === v : true))
      if (!ok) return { status: 'unknown', reason: 'the contact change could not be confirmed by a fresh read', externalId: p.contactId }
      return { status: 'succeeded', reason: null, externalId: p.contactId, verified: true, result: { lifecycleStage: fresh!.lifecycleStage } }
    }
    if (p.type === 'deal_stage') {
      await hs.updateDealStage(p.dealId, p.stage)
      const fresh = await hs.getDeal(p.dealId)
      if (fresh?.stage !== p.stage) return { status: 'unknown', reason: 'the deal stage could not be confirmed by a fresh read', externalId: p.dealId }
      return { status: 'succeeded', reason: null, externalId: p.dealId, verified: true, result: { stage: fresh.stage } }
    }
  } catch (e) { return failure(e, 'HubSpot') }
  return { status: 'failed', reason: 'not a CRM action' }
}

const EMAIL_TO_ACTION: Record<EmailStatus, ActionStatus> = {
  accepted: 'succeeded', delivery_unknown: 'unknown', sending: 'unknown', queued: 'queued', failed: 'failed', cancelled: 'cancelled', awaiting_approval: 'failed', draft: 'failed',
}

/** Create (once) the email engine message for an email action. Its approval mirrors the action's, bound to the message's own content hash. */
async function ensureMessage(a: OfficeActionRow, ctx: AgentCtx): Promise<{ id: string } | { error: string }> {
  const p = a.payload as EmailPayload
  return admin(async db => {
    const existing = await db.one<EmailMessageRow>(`select * from email_messages where office_agent_id = $1 and dedupe_key = $2 for update`, [a.agent_id, a.idempotency_key])
    if (existing && !(existing.status === 'cancelled' && existing.attempts === 0 && !existing.accepted_at)) {
      await db.query('update office_actions set email_message_id = $2 where id = $1', [a.id, existing.id])
      return { id: existing.id }
    }
    const account = await db.one<{ id: string; org_id: string; address: string; provider: string; status: string; office_mailbox: boolean; agent_id: string | null }>('select * from email_accounts where id = $1', [ctx.policy!.mailboxAccountId])
    if (!account || account.org_id !== a.org_id) return { error: 'the mailbox is not connected to this organization' }
    const thread = p.inReplyToMessageId ? await db.one<{ internet_message_id: string }>('select internet_message_id from email_messages where id = $1 and org_id = $2', [p.inReplyToMessageId, a.org_id]) : null
    // a reply to mail read from a Gmail / Outlook inbox: threaded on the inbound message, sent in the provider's own thread
    const src = p.recipientSource.kind === 'inbound' && (account.provider === 'gmail' || account.provider === 'microsoft')
      ? await db.one<{ internet_message_id: string | null; provider_message_id: string | null; provider_thread_id: string | null }>('select internet_message_id, provider_message_id, provider_thread_id from email_inbound where id = $1 and org_id = $2 and account_id = $3', [p.recipientSource.inboundId, a.org_id, account.id])
      : null
    const providerReply = src ? { provider: account.provider, message_id: src.provider_message_id, thread_id: src.provider_thread_id } : null
    const inReplyTo = src?.internet_message_id ?? thread?.internet_message_id ?? null
    const content = { subject: p.subject.replace(/[\r\n]+/g, ' ').slice(0, 250), bodyText: p.body.slice(0, 50_000), attachments: [] }
    const hash = contentHash({ from: account.address, to: [p.to.toLowerCase()], cc: [], content })
    const deploi = account.provider === 'deploi'
    let id: string
    if (existing) {
      id = existing.id
      await db.query(`update email_messages set status = 'draft', status_reason = null, content_hash = $2, from_address = $3, to_addresses = $4, account_id = $5 where id = $1`, [id, hash, account.address, [p.to.toLowerCase()], account.id])
    } else {
      id = (await db.one<{ id: string }>(`insert into email_messages (org_id, agent_id, office_agent_id, office_action_id, run_id, account_id, policy_id, policy_version, task_key, dedupe_key, status, from_address, to_addresses, cc_addresses,
          attachment_count, attachment_bytes, key_id, content_ciphertext, content_hash, internet_message_id, meta, in_reply_to, reply_token)
        values ($1,null,$2,$3,null,$4,null,$5,'office',$6,'draft',$7,$8,'{}',0,0,'pending','pending',$9,$10,$11,$12,$13) returning id`,
        [a.org_id, a.agent_id, a.id, account.id, ctx.policyVersion, a.idempotency_key, account.address, [p.to.toLowerCase()], hash,
          newInternetMessageId(deploi ? emailConfig.agentMailDomain || undefined : undefined), JSON.stringify({ office: true, purpose: a.purpose, ...p.meta, ...(providerReply ? { provider_reply: providerReply } : {}) }), inReplyTo, deploi ? randomBytes(16).toString('hex') : null]))!.id
    }
    const enc = encryptSecret(JSON.stringify(content), `email-message:${id}`)
    await db.query(`update email_messages set key_id = $2, content_ciphertext = $3, status = 'queued', status_reason = $4, approval_kind = $5, approved_by = $6, approved_hash = content_hash, approved_at = now(), next_attempt_at = null where id = $1`,
      [id, enc.keyId, enc.ciphertext, a.approval_kind === 'standing' ? 'covered by the standing authorization' : 'approved by you', a.approval_kind, a.approved_by])
    await db.query('update office_actions set email_message_id = $2 where id = $1', [a.id, id])
    return { id }
  })
}

/** Lead follow-up only: re-read the contact in HubSpot just before sending; the lead's own current address is the only one allowed. */
async function leadPrecheck(a: OfficeActionRow, conn: OfficeConnectionRow | null): Promise<Outcome | null> {
  if (!a.lead_id) return null
  const lead = await admin(db => db.one<{ id: string; status: string; email: string; hubspot_contact_id: string; replied_at: string | null }>('select * from office_leads where id = $1', [a.lead_id]))
  if (!lead) return { status: 'cancelled', reason: 'the lead no longer exists' }
  if (lead.status !== 'active') return { status: 'cancelled', reason: `the lead is ${lead.status}; nothing more is sent` }
  if (!conn || conn.status !== 'active') return { status: 'failed', reason: 'HubSpot is not connected, so the lead could not be checked before sending' }
  try {
    const c = await hubspotFor(conn).getContact(lead.hubspot_contact_id)
    const stop = async (why: string): Promise<Outcome> => { await stopLead(lead.id, why, 'system:office'); return { status: 'cancelled', reason: `not sent: ${why}` } }
    if (!c) return stop('the contact was deleted in HubSpot')
    if (c.optedOut) return stop('the contact is opted out of email in HubSpot')
    if (c.lifecycleStage !== 'lead') return stop(`the contact's lifecycle stage changed to "${c.lifecycleStage ?? 'none'}"`)
    if (!c.email || c.email !== (a.payload as EmailPayload).to.toLowerCase()) return stop("the contact's email address changed in HubSpot")
  } catch (e) { const f = failure(e, 'HubSpot check before sending'); return f.status === 'unknown' ? { status: 'queued', reason: f.reason, nextAttemptAt: new Date(Date.now() + 5 * 60e3).toISOString() } : f }
  return null
}

export async function stopLead(leadId: string, reason: string, actor: string, status: 'stopped' | 'replied' | 'completed' = 'stopped') {
  await admin(async db => {
    const l = await db.one<{ id: string; org_id: string; status: string }>(`update office_leads set status = $2, stop_reason = $3, next_touch_at = null, replied_at = case when $2 = 'replied' then coalesce(replied_at, now()) else replied_at end
      where id = $1 and status = 'active' returning id, org_id, status`, [leadId, status, reason])
    if (!l) return
    await db.query(`update office_actions set status = 'cancelled', status_reason = $2, next_attempt_at = null where lead_id = $1 and status in ('draft','awaiting_approval','queued')`, [leadId, `follow-up stopped: ${reason}`])
    await officeAudit(db, { orgId: l.org_id, entityType: 'office_lead', entityId: leadId, event: `lead.${status}`, actor, detail: { reason } })
  })
}

/**
 * Checks other Office modules run just before an email goes out (e.g. Accounts Receivable re-reads the invoice in
 * QuickBooks). A non-null answer stops this send with that outcome; nothing is sent.
 */
export type EmailPrecheck = (a: OfficeActionRow, ctx: AgentCtx) => Promise<{ status: 'cancelled' | 'failed' | 'queued'; reason: string; nextAttemptAt?: string | null } | null>
const emailPrechecks: EmailPrecheck[] = []
export function registerEmailPrecheck(f: EmailPrecheck) { if (!emailPrechecks.includes(f)) emailPrechecks.push(f) }

async function performEmail(a: OfficeActionRow, ctx: AgentCtx, conn: OfficeConnectionRow | null, actor: string, now: Date): Promise<Outcome> {
  const pre = await leadPrecheck(a, conn)
  if (pre) return pre
  for (const f of emailPrechecks) { const r = await f(a, ctx); if (r) return r }
  const m = await ensureMessage(a, ctx)
  if ('error' in m) return { status: 'failed', reason: m.error }
  const out = await sendMessage(m.id, { actor, now })
  const msg = await admin(db => db.one<EmailMessageRow>('select * from email_messages where id = $1', [m.id]))
  const status = EMAIL_TO_ACTION[msg?.status ?? out.status]
  if (status === 'succeeded') return { status, reason: null, emailMessageId: m.id, externalId: msg?.provider_message_id ?? null, verified: Boolean(msg?.accepted_at), result: { evidence: msg?.accepted_evidence ?? null, threadId: msg?.provider_thread_id ?? null } }
  return { status, reason: msg?.status_reason ?? out.reason ?? null, emailMessageId: m.id, nextAttemptAt: status === 'queued' ? msg?.next_attempt_at ?? new Date(Date.now() + 60e3).toISOString() : null }
}

/**
 * Carry out one queued action: claim it under a lock after every gate passed, do it, confirm it with a
 * fresh read, record the outcome. A concurrent caller sees Executing and stops.
 */
export async function executeOfficeAction(actionId: string, opts: { now?: Date; actor?: string } = {}): Promise<{ actionId: string; status: ActionStatus; reason: string | null }> {
  const now = opts.now ?? new Date()
  const c = await claim(actionId, now, opts.actor)
  if (c.kind === 'skip') { await actionSettled(actionId, now); return { actionId, status: c.status, reason: c.reason } }
  const { a, ctx, conn, actor } = c
  let out: Outcome
  try {
    out = a.kind === 'send_email' ? await performEmail(a, ctx, conn, actor, now)
      : TOOL_OF[a.kind] === 'calendar' ? await performEvent(a, conn!)
      : await performCrm(a, conn!)
  } catch (e) { out = uncertain(e) ? { status: 'unknown', reason: 'no definite answer; checking before any retry' } : failure(e, a.kind) }
  await finishAction(a, out, actor, now)
  await actionSettled(actionId, now)
  return { actionId, status: out.status, reason: out.reason }
}

/**
 * After an action was carried out, refused or declined, the Resolution Engine moves the case the action
 * belongs to (lib/office/resolution.ts registers the hook). A hook failure never changes the action's outcome:
 * the case's durable check catches up.
 */
type SettledHook = (actionId: string, now: Date) => Promise<void>
const settledHooks: SettledHook[] = []
export function onOfficeActionSettled(h: SettledHook) { if (!settledHooks.includes(h)) settledHooks.push(h) }
export async function actionSettled(actionId: string, now: Date) {
  for (const h of settledHooks) {
    try { await h(actionId, now) } catch (e) { const { log } = await import('../log'); log.error('office.case_sync_failed', { action_id: actionId, error: (e as Error).message?.slice(0, 300) }) }
  }
}

async function finishAction(a: OfficeActionRow, out: Outcome, actor: string, now: Date) {
  await admin(async db => {
    const extra: Record<string, unknown> = {}
    if (out.externalId !== undefined) extra.external_id = out.externalId
    if (out.result) extra.result = out.result
    if (out.emailMessageId) extra.email_message_id = out.emailMessageId
    extra.next_attempt_at = out.status === 'queued' ? out.nextAttemptAt ?? null : null
    if (out.status === 'succeeded') { extra.executed_at = now.toISOString(); if (out.verified) extra.verified_at = now.toISOString() }
    const row = await setStatus(db, a, out.status, out.reason, actor, extra)
    if (out.status === 'succeeded') await onSucceeded(db, row, now)
    if (out.status === 'failed' && row.meeting_id && row.kind === 'create_event') await db.query(`update office_meetings set status = 'failed', status_reason = $2 where id = $1 and status in ('booking','proposed')`, [row.meeting_id, out.reason])
  })
}

/** What a confirmed action changes in the office records (lead cadence, meeting state, confirmation email). */
async function onSucceeded(db: Db, a: OfficeActionRow, now: Date) {
  const ctx = await agentCtx(db, a.agent_id)
  if (a.kind === 'send_email' && a.lead_id && ctx?.policy?.leadFollowup) {
    const touch = Number((a.payload as EmailPayload).meta.touch ?? 1)
    const l = ctx.policy.leadFollowup
    const last = touch >= l.maxTouches
    await db.query(`update office_leads set touches = greatest(touches, $2), last_touch_at = $3, next_touch_at = $4, thread_message_id = coalesce(thread_message_id, $5), last_message_id = $5,
      status = case when $6 and status = 'active' then 'completed' else status end, stop_reason = case when $6 and status = 'active' then 'all follow-ups sent' else stop_reason end where id = $1`,
      [a.lead_id, touch, now.toISOString(), last ? null : new Date(now.getTime() + l.followupDays * 864e5).toISOString(), a.email_message_id, last])
  }
  if (a.kind === 'send_email' && a.meeting_id && (a.payload as EmailPayload).meta.step === 'proposal')
    await db.query(`update office_meetings set status = 'proposed', proposal_message_id = $2 where id = $1 and status = 'proposing'`, [a.meeting_id, a.email_message_id])
  if (a.kind === 'create_event' && a.meeting_id) {
    const m = await db.one<{ id: string; contact_email: string; chosen_slot: { start: string; end: string; label: string }; proposal_message_id: string | null }>(`update office_meetings set status = 'booked', calendar_event_id = $2, meet_link = $3, calendar_link = $4
      where id = $1 returning id, contact_email, chosen_slot, proposal_message_id`, [a.meeting_id, a.external_id, (a.result?.meetLink as string | null) ?? null, (a.result?.htmlLink as string | null) ?? null])
    if (m && ctx?.policy?.scheduler && ctx.agent.status === 'active') {
      const { meetingConfirmation } = await import('./content')
      const subject = m.proposal_message_id ? (await db.one<{ meta: Record<string, unknown> }>('select meta from email_messages where id = $1', [m.proposal_message_id]))?.meta.subject as string | null ?? null : null
      const d = meetingConfirmation(null, ctx.policy.scheduler.senderName, m.chosen_slot, (a.result?.meetLink as string | null) ?? null, subject)
      await proposeAction(db, { agentId: a.agent_id, kind: 'send_email', purpose: 'Meeting confirmation', idempotencyKey: `meeting:${m.id}:confirm`, meetingId: m.id, now,
        payload: { type: 'email', to: m.contact_email, subject: d.subject, body: d.body, inReplyToMessageId: m.proposal_message_id, recipientSource: { kind: 'meeting', meetingId: m.id }, meta: { step: 'confirmation', subject: d.subject } } })
    }
  }
}

// ---------------------------------------------------------------- reconciliation

/**
 * Interrupted executions become Unknown; Unknown outcomes are looked up, never blindly retried:
 * email follows the email engine's own reconciliation; events are read by their deterministic id; notes
 * and tasks are searched by their marker (twice, five minutes apart, before a retry: search indexes lag);
 * contact and deal changes are re-read (they set a value, so a re-try is harmless once the read differs).
 */
export async function reconcileOfficeActions(opts: { now?: Date; orgId?: string; limit?: number } = {}) {
  const now = opts.now ?? new Date()
  await admin(db => db.query(`update office_actions set status = 'unknown', status_reason = 'the execution was interrupted; checking what happened before any retry'
    where status = 'executing' and executing_started_at < $1 and ($2::uuid is null or org_id = $2)`, [new Date(now.getTime() - 10 * 60e3).toISOString(), opts.orgId ?? null]))
  const open = await admin(db => db.query<OfficeActionRow>(`select * from office_actions where status = 'unknown' and ($1::uuid is null or org_id = $1) order by updated_at limit $2`, [opts.orgId ?? null, opts.limit ?? 50]))
  const out: { actionId: string; status: ActionStatus }[] = []
  for (const a of open) out.push({ actionId: a.id, status: await reconcileOne(a, now) })
  return out
}

export async function reconcileOne(a: OfficeActionRow, now = new Date()): Promise<ActionStatus> {
  const actor = 'system:office-reconcile'
  const settle = (o: Outcome) => finishAction(a, o, actor, now).then(() => o.status)
  if (a.kind === 'send_email') {
    if (!a.email_message_id) return settle({ status: 'queued', reason: 'no message was created; safe to try again', nextAttemptAt: null })
    const m = await admin(db => db.one<EmailMessageRow>('select * from email_messages where id = $1', [a.email_message_id]))
    const s = m ? EMAIL_TO_ACTION[m.status] : 'failed'
    if (s === 'unknown') return 'unknown' // the email engine is still reconciling; nothing is resent until it decides
    if (s === 'succeeded') return settle({ status: 'succeeded', reason: null, externalId: m?.provider_message_id ?? null, verified: true, emailMessageId: m?.id })
    return settle({ status: s, reason: m?.status_reason ?? null, emailMessageId: m?.id ?? null, nextAttemptAt: m?.next_attempt_at ?? null })
  }
  const ctx = await admin(db => agentCtx(db, a.agent_id))
  const conn = ctx?.policy ? await admin(db => connectionFor(db, a, ctx.policy!)) : null
  if (!conn || conn.status !== 'active') return 'unknown'
  const p = a.payload
  try {
    if (p.type === 'event' || p.type === 'event_patch' || p.type === 'event_delete') {
      const ev = await calendarFor(conn).getEvent(p.eventId)
      if (p.type === 'event') return ev && ev.status !== 'cancelled' ? settle({ status: 'succeeded', reason: 'confirmed by reading the event after an uncertain answer', externalId: ev.id, verified: true, result: { meetLink: ev.meetLink, htmlLink: ev.htmlLink, start: ev.start, end: ev.end } })
        : settle({ status: 'queued', reason: 'the event does not exist: booking again with the same event id', nextAttemptAt: null })
      if (p.type === 'event_patch') return ev && sameInstant(ev.start, p.start) && sameInstant(ev.end, p.end) ? settle({ status: 'succeeded', reason: 'confirmed by a fresh read', externalId: ev.id, verified: true }) : settle({ status: 'queued', reason: 'not changed yet: trying again', nextAttemptAt: null })
      return !ev || ev.status === 'cancelled' ? settle({ status: 'succeeded', reason: 'confirmed by a fresh read', externalId: p.eventId, verified: true }) : settle({ status: 'queued', reason: 'not cancelled yet: trying again', nextAttemptAt: null })
    }
    const hs = hubspotFor(conn)
    if (p.type === 'note' || p.type === 'task') {
      const found = p.type === 'note' ? await hs.findNoteByMarker(p.marker) : await hs.findTaskByMarker(p.marker)
      if (found) return settle({ status: 'succeeded', reason: 'found by its marker after an uncertain answer', externalId: found.id, verified: true })
      const checks = Number(a.result?.reconcileChecks ?? 0) + 1
      const first = String(a.result?.firstCheckAt ?? now.toISOString())
      if (checks >= 2 && now.getTime() - new Date(first).getTime() >= 5 * 60e3) return settle({ status: 'queued', reason: 'not found on two checks five minutes apart: writing it once more', nextAttemptAt: null, result: { reconcileChecks: checks, firstCheckAt: first } })
      await admin(db => db.query(`update office_actions set result = $2, status_reason = 'not found yet; HubSpot search can lag, checking again before deciding' where id = $1`, [a.id, JSON.stringify({ ...(a.result ?? {}), reconcileChecks: checks, firstCheckAt: first })]))
      return 'unknown'
    }
    if (p.type === 'contact_update') {
      const c = await hs.getContact(p.contactId)
      const ok = c && (p.properties.lifecyclestage === undefined || c.lifecycleStage === p.properties.lifecyclestage) && (p.properties.hs_email_optout === undefined || String(c.optedOut) === p.properties.hs_email_optout)
      return ok ? settle({ status: 'succeeded', reason: 'confirmed by a fresh read', externalId: p.contactId, verified: true }) : settle({ status: 'queued', reason: 'not changed yet: trying again', nextAttemptAt: null })
    }
    if (p.type === 'deal_stage') {
      const d = await hs.getDeal(p.dealId)
      return d?.stage === p.stage ? settle({ status: 'succeeded', reason: 'confirmed by a fresh read', externalId: p.dealId, verified: true }) : settle({ status: 'queued', reason: 'not changed yet: trying again', nextAttemptAt: null })
    }
  } catch { return 'unknown' }
  return 'unknown'
}

// ---------------------------------------------------------------- cancel (pause, revoke, disconnect)

/** Pause / revoke / delete: queued actions never run, and their queued emails are cancelled (revoke and delete also close drafts and approvals). */
export async function cancelAgentActions(db: Db, agentId: string, reason: string, includeAll: boolean) {
  const states = includeAll ? ['draft', 'awaiting_approval', 'queued'] : ['awaiting_approval', 'queued']
  const r = await db.query<{ id: string }>(`update office_actions set status = 'cancelled', status_reason = $2, next_attempt_at = null where agent_id = $1 and status = any($3::text[]) returning id`, [agentId, reason, states])
  const m = await db.query<{ id: string }>(`update email_messages set status = 'cancelled', status_reason = $2, next_attempt_at = null where office_agent_id = $1 and status in ('queued','awaiting_approval','draft') returning id`, [agentId, reason])
  return { actions: r.length, emails: m.length }
}

// ---------------------------------------------------------------- the email engine gate for office messages

registerOfficeSendGate(async (db, m) => {
  const a = m.office_action_id ? await db.one<OfficeActionRow>('select * from office_actions where id = $1', [m.office_action_id]) : null
  if (!a || a.org_id !== m.org_id) return { ok: false, status: 'cancelled', reason: 'this message has no office action' }
  if (!['executing', 'queued', 'unknown'].includes(a.status)) return { ok: false, status: 'cancelled', reason: `the office action is ${a.status.replace('_', ' ')}` }
  const ctx = await agentCtx(db, a.agent_id)
  if (!ctx || ctx.agent.id !== m.office_agent_id) return { ok: false, status: 'cancelled', reason: 'the office agent is missing' }
  if (ctx.agent.status !== 'active') return { ok: false, status: 'cancelled', reason: `the agent is ${ctx.agent.status}; queued messages are not sent` }
  const orgStopped = await orgStopReason(db, a.org_id)
  if (orgStopped) return { ok: false, status: 'cancelled', reason: `${orgStopped}; queued messages are not sent` }
  if (!(await hasProduct(db, a.org_id, 'office'))) return { ok: false, status: 'failed', reason: 'Deploi Office is not enabled for this organization' }
  if (!ctx.policy || ctx.policyStatus !== 'active') return { ok: false, status: 'cancelled', reason: 'the agent has no active authorization' }
  if (ctx.policy.mailboxAccountId !== m.account_id) return { ok: false, status: 'cancelled', reason: "the agent's mailbox changed; this message is no longer covered" }
  const p = a.payload as EmailPayload
  if (m.cc_addresses.length || m.to_addresses.length !== 1 || m.to_addresses[0] !== p.to.toLowerCase()) return { ok: false, status: 'cancelled', reason: 'the recipients differ from the approved action' }
  const b = await baseBlockers(db, ctx, a)
  if (b.length) return { ok: false, status: 'cancelled', reason: `cannot send: ${b.join('; ')}` }
  if (a.approval_kind === 'standing') {
    const t = ctx.policy.email
    if (t?.tier !== 'send_autonomous' || !t.validUntil || new Date(t.validUntil).getTime() <= Date.now()) return { ok: false, status: 'cancelled', reason: 'no longer covered by the standing authorization' }
  } else if (a.approval_kind !== 'individual') return { ok: false, status: 'cancelled', reason: 'not approved' }
  if (a.approved_hash !== a.payload_hash) return { ok: false, status: 'cancelled', reason: 'the action changed after approval' }
  // first contact: only an individual approval can send the first reply to a sender nobody trusted yet
  if (p.recipientSource.kind === 'inbound' && a.approval_kind !== 'individual' && await needsFirstReplyApproval(db, a.org_id, p.recipientSource.inboundId))
    return { ok: false, status: 'cancelled', reason: 'the first reply to a new sender needs your individual approval' }
  return { ok: true, policyId: ctx.policyId!, policyVersion: ctx.policyVersion }
})
