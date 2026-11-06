/**
 * First-run pacing (the backlog guard). For 24 hours after a system is connected, customer-facing messages (emails
 * and texts to customers, tenants, renters, vendors and suppliers) go out at most `firstRunHourlyCap` per rolling
 * hour per organization (pack settings, default 20). A connect can surface months of backlog at once: 50 overdue
 * invoices must not become 50 reminders in the first minute. Internal fixes (store data, records) are never paced,
 * and ask-first actions still wait for the owner as before (the pacing applies to what goes out on its own).
 *
 * takeOutboundSlot is the one gate: it records the message in autonomy_outbound when there is room, or records it in
 * autonomy_backlog with the time the hold ends. Callers:
 *  - the agent loop (lib/events/loop.ts), before an act_and_tell loop for an outbound action type opens; a held
 *    problem is not opened, and the event handler that found it runs again when the hold ends (an `event.handle` job
 *    queued for that time), so event-only agents (a new lead) are not lost; sweep agents also find it on the next sweep;
 *  - Office actions (lib/office/actions.ts), just before an email is claimed for sending; a held email stays queued
 *    with next_attempt_at at the end of the hold.
 * The same ref asking again (a retry) keeps the slot it was given.
 */
import type { Db } from '../db'

export const FIRST_RUN_MS = 24 * 3600e3
export const PACE_WINDOW_MS = 3600e3
export const DEFAULT_FIRST_RUN_CAP = 20
/** action types that send something to a person outside the business */
export const OUTBOUND_ACTIONS = ['send_customer_email', 'send_vendor_email', 'send_supplier_email', 'send_reminder', 'reply_to_lead', 'invoice_send', 'send_text'] as const
export const isOutboundAction = (t: string) => (OUTBOUND_ACTIONS as readonly string[]).includes(t)

export type Slot = { ok: true; paced: boolean } | { ok: false; releaseAt: Date; cap: number; reason: string }

/**
 * The latest connect of the organization still inside its first 24 hours whose first run has started (the
 * on-connect job surfaced the backlog), or null.
 */
export async function firstRunSince(db: Db, orgId: string, now: Date): Promise<Date | null> {
  const r = await db.one<{ connected_at: string }>(`select connected_at from autonomy_connects where org_id = $1 and status in ('running','done') and connected_at <= $2 and connected_at > $3 order by connected_at desc limit 1`,
    [orgId, now.toISOString(), new Date(now.getTime() - FIRST_RUN_MS).toISOString()])
  return r ? new Date(r.connected_at) : null
}

export async function firstRunCap(db: Db, orgId: string): Promise<number> {
  const r = await db.one<{ cap: unknown }>(`select settings->'firstRunHourlyCap' as cap from pack_settings where org_id = $1`, [orgId])
  const n = Number(r?.cap)
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : DEFAULT_FIRST_RUN_CAP
}

/**
 * Ask to send one customer-facing message now (in the caller's transaction). Outside the first 24 hours after a
 * connect: always ok, nothing recorded. Inside: ok while fewer than the cap went out in the last hour.
 */
export async function takeOutboundSlot(db: Db, orgId: string, ref: string, meta: { agentKey?: string | null; actionType?: string | null; eventId?: string | null }, now: Date): Promise<Slot> {
  const since = await firstRunSince(db, orgId, now)
  if (!since) return { ok: true, paced: false }
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 6363))`, [`autonomy-outbound:${orgId}`])
  const key = ref.slice(0, 320)
  if (await db.one('select 1 from autonomy_outbound where org_id = $1 and ref = $2', [orgId, key])) return { ok: true, paced: true }
  const cap = await firstRunCap(db, orgId)
  const windowStart = new Date(now.getTime() - PACE_WINDOW_MS)
  const inWindow = await db.query<{ created_at: string }>(`select created_at from autonomy_outbound where org_id = $1 and created_at > $2 and created_at <= $3 order by created_at`, [orgId, windowStart.toISOString(), now.toISOString()])
  if (inWindow.length < cap) {
    await db.query(`insert into autonomy_outbound (org_id, ref, agent_key, action_type, created_at) values ($1,$2,$3,$4,$5) on conflict (org_id, ref) do nothing`,
      [orgId, key, meta.agentKey?.slice(0, 120) ?? null, meta.actionType?.slice(0, 64) ?? null, now.toISOString()])
    await db.query(`update autonomy_backlog set released_at = $3 where org_id = $1 and ref = $2 and released_at is null`, [orgId, key, now.toISOString()])
    return { ok: true, paced: true }
  }
  // the hold ends when the oldest message of the window leaves it (one minute later, so the slot is surely free)
  const releaseAt = new Date(new Date(inWindow[inWindow.length - cap].created_at).getTime() + PACE_WINDOW_MS + 60e3)
  await db.query(`insert into autonomy_backlog (org_id, ref, agent_key, action_type, event_id, queued_at, release_at) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (org_id, ref) do update set release_at = excluded.release_at, released_at = null, event_id = coalesce(excluded.event_id, autonomy_backlog.event_id)`,
    [orgId, key, meta.agentKey?.slice(0, 120) ?? null, meta.actionType?.slice(0, 64) ?? null, meta.eventId ?? null, now.toISOString(), releaseAt.toISOString()])
  return { ok: false, releaseAt, cap, reason: `first-day pace: at most ${cap} customer messages an hour in the first 24 hours after connecting; this one goes out after ${releaseAt.toISOString()}` }
}

/** Messages held by the pacing and not sent yet. */
export async function heldCount(db: Db, orgId: string, since?: Date): Promise<number> {
  const r = await db.one<{ n: number }>(`select count(*)::int as n from autonomy_backlog where org_id = $1 and released_at is null and ($2::timestamptz is null or queued_at >= $2)`, [orgId, since?.toISOString() ?? null])
  return r?.n ?? 0
}
