/** Retention: 30/60/90-day SMS check-ins; rule-based quit-risk flag. No model inference on people. */
import type { Db } from '@/lib/db'
import { initials, type AgencyRow, type Proposal, type WorkerDef } from '@/lib/workers/types'
import { daysBetween } from './authorization_watch'

export type AideRow = { id: string; first_name: string; last_name: string; phone: string | null; hired_on: string | null; quit_risk: boolean }
export type CheckinDue = { aide: AideRow; day: 30 | 60 | 90; due_on: string }

export function checkinsDue(aides: AideRow[], now: Date, existing: { aide_id: string; day: number }[] = []): CheckinDue[] {
  const out: CheckinDue[] = []
  for (const a of aides) {
    if (!a.hired_on) continue
    for (const day of [30, 60, 90] as const) {
      const due = new Date(new Date(a.hired_on + 'T00:00:00Z').getTime() + day * 86400e3).toISOString().slice(0, 10)
      const delta = -daysBetween(now, due) // days since due
      if (delta < 0 || delta > 7) continue // due today or in the last week
      if (existing.some(e => e.aide_id === a.id && e.day === day)) continue
      out.push({ aide: a, day, due_on: due })
    }
  }
  return out
}

/** 2+ declined shifts AND a late clock-in (>10 min) inside the same 14-day window. */
export function quitRisk(declines: Date[], lateClockIns: Date[], windowDays = 14): { flagged: boolean; reason: string | null } {
  const w = windowDays * 86400e3
  for (const late of lateClockIns) {
    const near = declines.filter(d => Math.abs(d.getTime() - late.getTime()) <= w)
    if (near.length >= 2) return { flagged: true, reason: `${near.length} declined shifts and a late clock-in within ${windowDays} days` }
  }
  return { flagged: false, reason: null }
}

const MSG: Record<30 | 60 | 90, (n: string) => string> = {
  30: n => `Hi ${n}, you have been with us a month! How is it going? Reply with anything we can do better — schedules, clients, pay questions. We read every reply.`,
  60: n => `Hi ${n}, two months in. Anything about your shifts or clients we should fix? Reply here and the office will follow up this week.`,
  90: n => `Hi ${n}, 90 days! Thank you. If you would like more hours or different clients, reply and tell us; we will make it work.`,
}

export const retentionCheckins: WorkerDef = {
  name: 'retention_checkins', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const proposals: Proposal[] = []
    const aides = await db.query<AideRow>('select id, first_name, last_name, phone, hired_on::text as hired_on, quit_risk from aides where agency_id = $1 and active', [agency.id])
    const existing = await db.query<{ aide_id: string; day: number }>("select aide_id, day from retention_checkins where agency_id = $1 and status = 'sent'", [agency.id])
    for (const c of checkinsDue(aides, now, existing)) {
      const row = await db.one<{ id: string }>(
        "insert into retention_checkins (agency_id, aide_id, day, due_on, status) values ($1,$2,$3,$4,'proposed') on conflict (aide_id, day) do update set status = retention_checkins.status returning id",
        [agency.id, c.aide.id, c.day, c.due_on])
      proposals.push({ kind: 'sms', to_ref: `aide:${c.aide.id}`, body: MSG[c.day](c.aide.first_name), payload: { effect: 'retention_checkin_sent', checkin_id: row?.id, aide_id: c.aide.id, day: c.day, to_label: `Aide ${initials(c.aide.first_name, c.aide.last_name)}` }, dedupe_key: `retention:${c.aide.id}:${c.day}` })
    }
    const since = new Date(now.getTime() - 28 * 86400e3).toISOString()
    for (const a of aides) {
      const declines = await db.query<{ at: string }>("select responded_at as at from shift_offers where aide_id = $1 and response = 'no' and responded_at >= $2", [a.id, since])
      const late = await db.query<{ at: string }>("select actual_start as at from visits where aide_id = $1 and actual_start is not null and scheduled_start is not null and actual_start > scheduled_start + interval '10 minutes' and scheduled_start >= $2", [a.id, since])
      const q = quitRisk(declines.map(d => new Date(d.at)), late.map(l => new Date(l.at)))
      if (q.flagged && !a.quit_risk) {
        await db.query('update aides set quit_risk = true, quit_risk_reason = $2 where id = $1', [a.id, q.reason])
        proposals.push({ kind: 'task', to_ref: 'admin', subject: `Quit risk: Aide ${initials(a.first_name, a.last_name)}`, body: `${q.reason}. Suggest a call this week before a resignation lands.`, payload: { aide_id: a.id, to_label: 'Admin', reason: q.reason }, dedupe_key: `quitrisk:${a.id}:${now.toISOString().slice(0, 10)}` })
      } else if (!q.flagged && a.quit_risk) {
        await db.query('update aides set quit_risk = false, quit_risk_reason = null where id = $1', [a.id])
      }
    }
    return proposals
  },
}
