/**
 * The monthly agent-action allowance (the paid unit of a plan: PLAN_LIMITS.monthlyActions, which is the
 * tier's allowance in agent-library.json). Enforced only while BILLING_MODE is test or live; while billing
 * is off (the free beta) nothing here queries or refuses anything.
 *
 * What counts: one consequential action an agent carried out for the organization.
 *   store write      an agent's correction execution that was written: executions.status
 *                    executing | applied | verified | unknown (agent_id set), counted at started_at
 *   email send       an agent's message the provider accepted: email_messages.status
 *                    sending | accepted | delivery_unknown (agent_id set, not a person's own reply),
 *                    counted at sending_started_at
 *   Office action    an office action (email, booking, CRM write) that succeeded: office_actions.status
 *                    executing | succeeded | unknown, counted at executing_started_at. An Office email
 *                    counts once, as its office action (its engine message has no agent_id).
 *   library write    a library agent's store write that was done: library_actions.status = 'done',
 *                    counted at executed_at
 * In-flight and unconfirmed outcomes (executing, sending, unknown) count while they are open, so two
 * concurrent claims cannot both pass the last slot; one that resolves as failed stops counting.
 * What does not count: drafts, proposals, approvals, reports, anything refused, blocked, stale,
 * cancelled or failed, and runs themselves (a run only produces drafts and proposals).
 *
 * The month is the calendar month in UTC (the same window as the monthly email allowance); it resets at
 * 00:00 UTC on the first day of the next month.
 *
 * When the allowance is used, work is held, never dropped: a store write goes back to "waiting for your
 * approval" (its approval is withdrawn, so it can be approved again next month or after an upgrade), an
 * email waits for approval, an Office action waits for approval, and a library auto-run write is kept as a
 * draft. Individually approved items are held too: the allowance is the paid unit whoever approved it.
 */
import type { Db } from '../db'
import { billingMode } from '../billing/config'
import { monthStart, orgEntitlements } from './entitlements'

export const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))

/** Carried-out agent actions of the organization in the UTC calendar month of `now` (see the rules above). */
export async function actionsUsed(db: Db, orgId: string, now = new Date()): Promise<number> {
  const from = monthStart(now).toISOString(), to = monthEnd(now).toISOString()
  const r = await db.one<{ n: string }>(
    `select (
       (select count(*) from executions where org_id = $1 and agent_id is not null and status in ('executing','applied','verified','unknown') and started_at >= $2 and started_at < $3)
     + (select count(*) from email_messages where org_id = $1 and agent_id is not null and task_key <> 'human_reply' and status in ('sending','accepted','delivery_unknown') and sending_started_at >= $2 and sending_started_at < $3)
     + (select count(*) from office_actions where org_id = $1 and status in ('executing','succeeded','unknown') and executing_started_at >= $2 and executing_started_at < $3)
     + (select count(*) from library_actions where org_id = $1 and status = 'done' and executed_at >= $2 and executed_at < $3)
     )::text as n`, [orgId, from, to])
  return Number(r?.n ?? 0)
}

/** Emails counted against the monthly email allowance (the same rule as billingSendBlock). */
export async function emailsUsed(db: Db, orgId: string, now = new Date()): Promise<number> {
  const r = await db.one<{ n: string }>(`select count(*)::text as n from email_messages where org_id = $1 and status in ('sending','accepted','delivery_unknown') and created_at >= $2 and created_at < $3`,
    [orgId, monthStart(now).toISOString(), monthEnd(now).toISOString()])
  return Number(r?.n ?? 0)
}

export const allowanceReason = (limit: number, resetsAt: Date) =>
  `this month's allowance of ${limit} actions is used; it resets on ${resetsAt.toISOString().slice(0, 10)} or on upgrade`

export type AllowanceBlock = { reason: string; used: number; limit: number; resetsAt: string }

/**
 * Why one more agent action may not be carried out now (the allowance is used), or null. No query while
 * billing is off. With `lock`, the count runs under a per-organization transaction lock, so a caller that
 * claims the action in the same transaction cannot race another claim past the last slot.
 */
export async function allowanceBlock(db: Db, orgId: string, opts: { now?: Date; lock?: boolean } = {}): Promise<AllowanceBlock | null> {
  if (billingMode() === 'off') return null
  const now = opts.now ?? new Date()
  if (opts.lock) await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 4211))`, [`allowance:${orgId}`])
  const e = await orgEntitlements(db, orgId, now)
  const used = await actionsUsed(db, orgId, now)
  if (used < e.monthlyActions) return null
  const resetsAt = monthEnd(now)
  return { reason: allowanceReason(e.monthlyActions, resetsAt), used, limit: e.monthlyActions, resetsAt: resetsAt.toISOString() }
}

export type PlanUsage = { actions: number; actionsLimit: number | null; emails: number; emailsLimit: number | null; resetsAt: string; enforced: boolean }

/** Usage against the plan this month (limits are null while billing is off: the free beta enforces none). */
export async function planUsage(db: Db, orgId: string, now = new Date()): Promise<PlanUsage> {
  const enforced = billingMode() !== 'off'
  const e = enforced ? await orgEntitlements(db, orgId, now) : null
  return { actions: await actionsUsed(db, orgId, now), actionsLimit: e?.monthlyActions ?? null, emails: await emailsUsed(db, orgId, now), emailsLimit: e?.monthlyEmails ?? null, resetsAt: monthEnd(now).toISOString(), enforced }
}
