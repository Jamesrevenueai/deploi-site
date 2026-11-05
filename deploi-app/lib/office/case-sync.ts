/**
 * Helpers that carry an Office record's state onto its Resolution Engine case (lib/cases). Office records
 * (leads, meetings, actions, inbound mail) are the source; the case follows them through the one lifecycle,
 * one allowed transition at a time. Nothing here sends, writes to a provider or widens a permission: a case
 * is the customer's view of the work, never a route around the policy that each agent acts under.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { decryptSecret } from '../connectors/credentials'
import { orgStopReason } from '../engine/kill-switch'
import { canTransition, CASE_STATUSES, linkRecord, recordAction, TERMINAL, transitionCase, type CaseRow, type CaseStatus, type Evidence } from '../cases'
import type { ActionStatus, AgentCtx, OfficeActionRow } from './actions'

export const RESOLUTION_ACTOR = 'system:office-resolution'
export const actorOf = (ctx: AgentCtx | null) => (ctx ? `office-agent:${ctx.agent.name.slice(0, 60)}@v${ctx.policyVersion}` : RESOLUTION_ACTOR)

export type CaseTarget = {
  status: CaseStatus; reason: string
  nextAction?: string | null; nextCheckAt?: Date | null
  evidence?: Evidence[]; ref?: { type: string; id: string } | null
}

/** Shortest chain of allowed transitions from one status to another (never through resolved). */
export function pathTo(from: CaseStatus, to: CaseStatus): CaseStatus[] | null {
  if (from === to) return []
  const prev = new Map<CaseStatus, CaseStatus>()
  const queue: CaseStatus[] = [from]
  const seen = new Set<CaseStatus>([from])
  while (queue.length) {
    const s = queue.shift()!
    for (const n of CASE_STATUSES) {
      if (n === 'resolved' || seen.has(n) || !canTransition(s, n)) continue
      seen.add(n); prev.set(n, s)
      if (n === to) {
        const path: CaseStatus[] = [n]
        let p = s
        while (p !== from) { path.unshift(p); p = prev.get(p)! }
        return path
      }
      queue.push(n)
    }
  }
  return null
}

/**
 * Move a case to the status its records show, through allowed transitions only. Same status: the reason,
 * next action and next check are refreshed (a changed reason is kept as a note in the history).
 */
export async function moveCase(caseId: string, t: CaseTarget, actor: string): Promise<CaseRow | null> {
  return admin(async db => {
    const c = await db.one<CaseRow>('select * from cases where id = $1 for update', [caseId])
    if (!c || TERMINAL.includes(c.status)) return c
    const approval = t.status === 'awaiting_approval'
    const nextCheck = t.nextCheckAt === undefined ? undefined : t.nextCheckAt
    if (c.status === t.status) {
      if (c.status_reason !== t.reason.slice(0, 1000)) await db.query(`insert into case_events (case_id, org_id, actor, type, summary) values ($1,$2,$3,'note',$4)`, [c.id, c.org_id, actor.slice(0, 160), t.reason.slice(0, 1000)])
      return db.one<CaseRow>(`update cases set status_reason = $2, next_action = case when $3::boolean then $4 else next_action end, next_check_at = case when $5::boolean then $6::timestamptz else next_check_at end,
        approval_required = $7 where id = $1 returning *`, [c.id, t.reason.slice(0, 1000), t.nextAction !== undefined, t.nextAction?.slice(0, 1000) ?? null, nextCheck !== undefined, nextCheck?.toISOString() ?? null, approval])
    }
    const path = pathTo(c.status, t.status)
    if (!path) { log.error('office.case_move_impossible', { case_id: c.id, from: c.status, to: t.status }); return c }
    let row: CaseRow = c
    for (const [n, s] of path.entries()) {
      const last = n === path.length - 1
      row = await transitionCase(db, c.id, { to: s, actor, reason: t.reason, approvalRequired: s === 'awaiting_approval',
        ...(last ? { nextAction: t.nextAction, nextCheckAt: nextCheck, evidence: t.evidence, ref: t.ref ?? null } : {}) })
    }
    return row
  })
}

export async function isLinked(db: Db, caseId: string, type: string, id: string) {
  return Boolean(await db.one('select 1 from case_links where case_id = $1 and ref_type = $2 and ref_id = $3', [caseId, type, id]))
}

/** Link a record once (an Office action when it is proposed, an inbound message, a meeting). */
export async function ensureLink(caseId: string, r: { type: string; id: string; label?: string }, actor: string) {
  await admin(async db => { if (!(await isLinked(db, caseId, r.type, r.id))) await linkRecord(db, caseId, r, actor) })
}

/** Record a completed action once, by the record it produced (an email message, a calendar event, a CRM note). */
export async function ensureActionRecorded(caseId: string, a: { summary: string; ref: { type: string; id: string }; detail?: Record<string, unknown> }, actor: string) {
  await admin(async db => {
    if (await isLinked(db, caseId, a.ref.type, a.ref.id)) return
    const c = await db.one<{ status: CaseStatus }>('select status from cases where id = $1', [caseId])
    if (!c || TERMINAL.includes(c.status)) return
    await recordAction(db, caseId, { actor, summary: a.summary, ref: a.ref, detail: a.detail })
  })
}

/** Link every Office action of a case (at any status) as `office_action`. */
export async function linkActions(caseId: string, acts: Pick<OfficeActionRow, 'id' | 'purpose'>[], actor: string) {
  for (const a of acts) await ensureLink(caseId, { type: 'office_action', id: a.id, label: a.purpose }, actor)
}

/** The case status an Office action's status maps to while it is the current step. */
export function stepFor(a: Pick<OfficeActionRow, 'status' | 'status_reason' | 'purpose'>, what: string): CaseTarget {
  const s: ActionStatus = a.status
  if (s === 'draft') return { status: 'proposed', reason: `${what}: drafted (${a.purpose}); this agent only drafts, nothing goes out`, nextAction: 'Review the draft. To let the agent carry it out, widen its permission and grant it.', nextCheckAt: null }
  if (s === 'awaiting_approval') return { status: 'awaiting_approval', reason: `${what}: ${a.purpose} waits for your approval${a.status_reason && !/waiting for your approval of this exact item/.test(a.status_reason) ? ` (${a.status_reason})` : ''}`, nextAction: 'Approve or decline the exact item in Approvals.', nextCheckAt: null }
  if (s === 'queued' || s === 'executing' || s === 'unknown') return { status: 'executing', reason: `${what}: ${a.purpose} is being carried out${a.status_reason ? ` (${a.status_reason})` : ''}`, nextAction: null }
  return { status: 'blocked', reason: `${what}: ${a.purpose} was ${s.replace('_', ' ')}${a.status_reason ? ` (${a.status_reason})` : ''}`, nextAction: 'Look at the item in the work log; the agent proposes it again when it can.' }
}

export async function stopped(orgId: string) { return admin(db => orgStopReason(db, orgId)) }

/**
 * While the organization's "stop all agents" is on, every open Office case is shown as blocked (with the
 * stop as the reason) and nothing advances it. Turning the stop off and resuming the agents lets the next
 * run or check move each case back to what its records show.
 */
export async function blockForStop(orgId: string, reason: string, opts: { caseId?: string } = {}) {
  const open = await admin(db => db.query<{ id: string }>(`select id from cases where org_id = $1 and suite = 'office' and status not in ('resolved','cancelled','blocked') and ($2::uuid is null or id = $2)`, [orgId, opts.caseId ?? null]))
  for (const c of open) await moveCase(c.id, { status: 'blocked', reason, nextAction: 'Turn the stop off and resume the agents; nothing is sent, written or checked until then.' }, 'system:org-stop')
  return open.length
}

export type InboundMail = { id: string; org_id: string; account_id: string; from_address: string; thread_message_id: string | null; internet_message_id: string | null; received_at: string; status: string; auto_reply: boolean; auto_reply_reason: string | null; classification: string; key_id: string; content_ciphertext: string }

/** The decrypted subject and text of an inbound message (data, never instructions). */
export function inboundContent(i: Pick<InboundMail, 'id' | 'key_id' | 'content_ciphertext'>): { subject: string; text: string } {
  if (i.key_id === 'pending') return { subject: '', text: '' }
  try { return JSON.parse(decryptSecret(i.key_id, i.content_ciphertext, `email-inbound:${i.id}`)) as { subject: string; text: string } } catch { return { subject: '', text: '' } }
}

export const iso = (v: string | Date) => new Date(v).toISOString()
export const day = (v: string | Date) => iso(v).slice(0, 10)
