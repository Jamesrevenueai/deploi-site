/**
 * Shared worker runner. Every worker proposes; proposals land in proposed_actions with status
 * "proposed". Approval and execution are separate steps:
 *   approveAction()  proposed -> approved            (a staff decision, or the agency's auto-send toggle)
 *   executeAction()  approved | queued -> attempted -> delivered | failed | unknown   (consent, expiry,
 *                    contact window and recipient are checked right before the adapter call)
 * A mock-adapter send is delivered + simulated. Provider acceptance is NOT delivery: a real adapter
 * result leaves the row 'attempted' / 'provider_accepted' until the delivery webhook confirms it, and
 * markUnknownDeliveries() turns it 'unknown' after a configurable window. See docs/action-safeguards.md.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { sendEmail } from '../adapters/email'
import { sendSms } from '../adapters/sms'
import { hasSmsConsent, NO_SMS_CONSENT } from '../consent/check'
import { opsConfig } from './config'
import { expiresAtFor, isExpired } from './expiry'
import { contactWindow, inContactWindow, nextWindowStart } from './window'
import type { AgencyRow, Proposal, WorkerDef, WorkerName } from './types'

const registry = new Map<WorkerName, WorkerDef>()
export function registerWorker(def: WorkerDef) { registry.set(def.name, def) }
export function getWorker(name: WorkerName) { return registry.get(name) }
export function listWorkers() { return [...registry.values()] }

export const ACTION_STATUSES = ['proposed', 'approved', 'queued', 'attempted', 'delivered', 'failed', 'unknown', 'skipped', 'expired', 'suppressed'] as const
export type ActionStatus = typeof ACTION_STATUSES[number]
export const PENDING_STATUSES: ActionStatus[] = ['proposed', 'approved', 'queued']
export const OUTSIDE_WINDOW = 'outside contact window'
export const NO_RECIPIENT = 'no reachable recipient'

export type ProposedActionRow = {
  id: string; agency_id: string; worker: string; kind: 'email' | 'sms' | 'task'; to_ref: string | null
  subject: string | null; body: string; payload: Record<string, unknown>; status: string; dedupe_key: string | null
  created_at: string; send_after: string | null; hold_reason?: string | null
  approved_at?: string | null; approved_by?: string | null; queued_at?: string | null; attempted_at?: string | null; attempt_count?: number
  delivered_at?: string | null; delivery_status?: string | null; provider_message_id?: string | null; failure_reason?: string | null
  simulated?: boolean; expires_at?: string | null; suppressed_reason?: string | null; idempotency_key?: string | null
}

export async function loadAgency(db: Db, agencyId: string): Promise<AgencyRow | null> {
  return db.one<AgencyRow>('select id, name, timezone, capacity_rules, radius_miles, interview_slots, auto_send from agencies where id = $1', [agencyId])
}

/** Insert one proposal (dedupe_key wins). Returns the new id, or null when it already existed. */
export async function insertProposal(db: Db, agency: { id: string; name: string }, worker: string, p: Proposal, now = new Date()): Promise<string | null> {
  const r = await db.one<{ id: string }>(
    `insert into proposed_actions (agency_id, agency_name, worker, kind, to_ref, subject, body, payload, status, dedupe_key, send_after, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9,$10,$11)
     on conflict (dedupe_key) do nothing returning id`,
    [agency.id, agency.name, worker, p.kind, p.to_ref, p.subject ?? null, p.body, JSON.stringify(p.payload ?? {}), p.dedupe_key, p.send_after ?? null, expiresAtFor(p, now)])
  return r?.id ?? null
}

export type RunSummary = { worker: WorkerName; agency_id: string; dry_run: boolean; proposed: number; inserted: number; sent: number; deferred: number; errors: number; run_id: string }

/** Run one worker for one agency. Dry-run only writes proposals (never sends). */
export async function runWorker(name: WorkerName, agencyId: string, opts: { dryRun?: boolean; now?: Date } = {}): Promise<RunSummary> {
  const def = registry.get(name)
  if (!def) throw new Error(`unknown worker ${name}`)
  const dryRun = opts.dryRun ?? true
  const now = opts.now ?? new Date()
  return admin(async db => {
    const agency = await loadAgency(db, agencyId)
    if (!agency) throw new Error('agency not found')
    const run = await db.one<{ id: string }>('insert into worker_runs (agency_id, worker, dry_run) values ($1,$2,$3) returning id', [agencyId, name, dryRun])
    let proposals: Proposal[] = []
    let errors = 0
    try {
      proposals = await def.propose(db, agency, now)
    } catch (e) {
      errors++
      log.error('worker.propose.failed', { worker: name, agency_id: agencyId, error: (e as Error).message })
    }
    let inserted = 0
    const insertedIds: string[] = []
    for (const p of proposals) {
      if (p.send_after && p.send_after > now) continue // not due yet
      const id = await insertProposal(db, agency, name, p, now)
      if (id) { inserted++; insertedIds.push(id) }
    }
    let sent = 0, deferred = 0
    // Auto-send is a per-agency, per-worker opt-in (default OFF). It approves on the agency's behalf, then executes.
    if (!dryRun && agency.auto_send?.[name] === true) {
      for (const id of insertedIds) {
        const approved = await approveAction(db, id, { actorId: null })
        if (!approved) { errors++; continue }
        const r = await executeAction(db, id, { actorId: null, now })
        if (r.deferred) deferred++
        else if (r.ok) sent++
        else errors++
      }
    }
    const summary = { worker: name, agency_id: agencyId, dry_run: dryRun, proposed: proposals.length, inserted, sent, deferred, errors, run_id: run!.id }
    await db.query('update worker_runs set finished_at = now(), summary = $2 where id = $1', [run!.id, JSON.stringify(summary)])
    log.info('worker.run', summary)
    return summary
  })
}

export async function runAllNightly(agencyId: string, opts: { dryRun?: boolean; now?: Date } = {}) {
  const out: RunSummary[] = []
  for (const def of registry.values()) if (def.nightly) out.push(await runWorker(def.name, agencyId, opts))
  return out
}

/** Resolve a to_ref descriptor to real delivery targets. Returns [] when nothing is reachable. */
export async function resolveRecipient(db: Db, agencyId: string, toRef: string | null, kind: 'email' | 'sms' | 'task'): Promise<string[]> {
  if (!toRef || kind === 'task') return []
  const [type, id] = toRef.split(':')
  if (type === 'scheduler' || type === 'admin') {
    const rows = await db.query<{ email: string }>("select email from profiles where agency_id = $1 and role = 'client'", [agencyId])
    return rows.map(r => r.email)
  }
  if (type === 'aide') { const r = await db.one<{ phone: string | null; email: string | null }>('select phone, email from aides where id = $1 and agency_id = $2', [id, agencyId]); return [kind === 'sms' ? r?.phone : r?.email].filter(Boolean) as string[] }
  if (type === 'family') { const r = await db.one<{ family_phone: string | null }>('select family_phone from clients where id = $1 and agency_id = $2', [id, agencyId]); return [r?.family_phone].filter(Boolean) as string[] }
  if (type === 'referrer') { const r = await db.one<{ source_email: string | null }>('select source_email from referrals where id = $1 and agency_id = $2', [id, agencyId]); return [r?.source_email].filter(Boolean) as string[] }
  if (type === 'applicant') { const r = await db.one<{ phone: string | null; email: string | null }>('select phone, email from applicants where id = $1 and agency_id = $2', [id, agencyId]); return [kind === 'sms' ? r?.phone : r?.email].filter(Boolean) as string[] }
  return []
}

// ---------------------------------------------------------------- approve
/**
 * Approve: proposed -> approved. Only records the decision (and an optional edit); nothing is sent here.
 * A held row (proposed + hold_reason) can be approved again once the hold is resolved.
 */
export async function approveAction(db: Db, id: string, opts: { actorId: string | null; overrides?: { subject?: string | null; body?: string } }): Promise<ProposedActionRow | null> {
  const a = await db.one<ProposedActionRow>("select * from proposed_actions where id = $1 and status = 'proposed' for update", [id])
  if (!a) return null
  const subject = opts.overrides?.subject === undefined ? a.subject : opts.overrides.subject
  const body = opts.overrides?.body ?? a.body
  const row = await db.one<ProposedActionRow>(
    `update proposed_actions set status = 'approved', approved_at = now(), approved_by = $2, decided_at = now(), decided_by = $2, subject = $3, body = $4
     where id = $1 returning *`, [id, opts.actorId, subject, body])
  log.info('action.approved', { id, worker: a.worker, by: opts.actorId ? 'staff' : 'auto_send' })
  return row
}

// ---------------------------------------------------------------- execute
export type ExecuteResult = {
  ok: boolean; status: string; noop?: boolean; deferred?: boolean; simulated?: boolean; reason?: string; delivery_status?: string | null
}

/**
 * Execute an approved (or queued, now due) action exactly once per idempotency scope.
 * Order of checks: idempotency -> expiry -> consent -> contact window -> recipient -> adapter.
 * The row is marked attempted BEFORE the adapter call so a crash mid-send can never produce a second send on retry.
 */
export async function executeAction(db: Db, id: string, opts: { actorId: string | null; idempotencyKey?: string; now?: Date } = { actorId: null }): Promise<ExecuteResult> {
  const now = opts.now ?? new Date()
  const a = await db.one<ProposedActionRow>('select * from proposed_actions where id = $1 for update', [id])
  if (!a) return { ok: false, status: 'missing', reason: 'not found' }
  const key = opts.idempotencyKey ?? `${a.id}:attempt:${(a.attempt_count ?? 0) + 1}`
  // idempotent: already executed under this key, or already attempted/delivered -> no-op
  if (a.idempotency_key === key || a.status === 'attempted' || a.status === 'delivered') return { ok: true, status: a.status, noop: true, delivery_status: a.delivery_status }
  if (!['approved', 'queued', 'failed', 'unknown'].includes(a.status)) return { ok: false, status: a.status, noop: true, reason: `not executable from ${a.status}` }
  const retrying = a.status === 'failed' || a.status === 'unknown'

  if (isExpired(a.expires_at, now)) {
    await db.query("update proposed_actions set status = 'expired', decided_at = coalesce(decided_at, now()) where id = $1", [id])
    log.info('action.expired', { id, worker: a.worker })
    return { ok: false, status: 'expired', reason: 'expired' }
  }

  // Consent is checked immediately before sending, never cached from approval time.
  if (a.kind === 'sms' && !(await hasSmsConsent(db, a.agency_id, a.to_ref))) {
    await db.query("update proposed_actions set status = 'proposed', hold_reason = $2 where id = $1", [id, NO_SMS_CONSENT])
    log.info('action.held', { id, worker: a.worker, reason: NO_SMS_CONSENT })
    return { ok: false, status: 'proposed', reason: NO_SMS_CONSENT }
  }

  if (a.kind === 'sms') {
    const agency = await loadAgency(db, a.agency_id)
    const tz = agency?.timezone || 'America/New_York'
    const w = contactWindow(agency?.capacity_rules)
    if (!inContactWindow(now, tz, w)) {
      const at = nextWindowStart(now, tz, w)
      await db.query("update proposed_actions set status = 'queued', queued_at = now(), send_after = $2, hold_reason = $3 where id = $1", [id, at, OUTSIDE_WINDOW])
      log.info('action.deferred', { id, worker: a.worker, send_after: at.toISOString() })
      return { ok: false, status: 'queued', deferred: true, reason: OUTSIDE_WINDOW }
    }
  }

  const targets = await resolveRecipient(db, a.agency_id, a.to_ref, a.kind)
  if (a.kind !== 'task' && !targets.length) {
    await db.query("update proposed_actions set status = 'failed', delivery_status = 'failed', failure_reason = $2, attempted_at = now(), attempt_count = attempt_count + 1, idempotency_key = $3, hold_reason = null where id = $1", [id, NO_RECIPIENT, key])
    log.warn('action.send.failed', { id, worker: a.worker, kind: a.kind, reason: NO_RECIPIENT })
    return { ok: false, status: 'failed', reason: NO_RECIPIENT }
  }

  // Mark attempted first: the idempotency key is committed with the attempt, so a retry under the same key is a no-op.
  await db.query("update proposed_actions set status = 'attempted', attempted_at = now(), attempt_count = attempt_count + 1, idempotency_key = $2, hold_reason = null, failure_reason = null where id = $1", [id, key])

  if (a.kind === 'task') {
    // A task is a record for the admin, not a transmission: approving it hands it over.
    await db.query("update proposed_actions set status = 'delivered', delivery_status = 'delivered', delivered_at = now(), sent_at = now() where id = $1", [id])
    return { ok: true, status: 'delivered', delivery_status: 'delivered', simulated: false }
  }

  let ok = true, mocked = true, providerId: string | null = null, error: string | undefined
  if (a.kind === 'email') {
    const r = await sendEmail({ to: targets, subject: a.subject ?? '(no subject)', text: a.body })
    ok = r.ok; mocked = r.mocked; providerId = r.id ?? null; error = r.error
  } else {
    for (const t of targets) {
      const r = await sendSms({ to: t, body: a.body })
      ok = r.ok && ok; mocked = r.mocked && mocked; providerId = r.sid ?? providerId; error = r.error ?? error
    }
  }
  if (!ok) {
    await db.query("update proposed_actions set status = 'failed', delivery_status = 'failed', failure_reason = $2, provider_message_id = coalesce($3, provider_message_id) where id = $1", [id, (error ?? 'send failed').slice(0, 300), providerId])
    log.warn('action.send.failed', { id, worker: a.worker, kind: a.kind, targets: targets.length, retry: retrying })
    return { ok: false, status: 'failed', reason: error ?? 'send failed' }
  }
  if (mocked) {
    // Simulated: the mock adapter recorded it. Visible everywhere as simulated; never a real outcome.
    await db.query("update proposed_actions set status = 'delivered', delivery_status = 'delivered', delivered_at = now(), sent_at = now(), simulated = true, provider_message_id = $2 where id = $1", [id, providerId])
    await applyEffect(db, a, { simulated: true })
    log.info('action.delivered.simulated', { id, worker: a.worker, kind: a.kind })
    return { ok: true, status: 'delivered', delivery_status: 'delivered', simulated: true }
  }
  // Provider accepted the message. Delivery is confirmed only by the provider's status callback.
  await db.query("update proposed_actions set delivery_status = 'provider_accepted', sent_at = now(), simulated = false, provider_message_id = $2 where id = $1", [id, providerId])
  await applyEffect(db, a, { simulated: false })
  log.info('action.provider_accepted', { id, worker: a.worker, kind: a.kind })
  return { ok: true, status: 'attempted', delivery_status: 'provider_accepted', simulated: false }
}

/**
 * Compatibility wrapper: approve then execute in one call (UI approve button, Twilio auto-send path, tests).
 * Returns true only when the adapter accepted the send (delivered or provider_accepted).
 */
export async function sendProposedAction(db: Db, id: string, opts: { actorId: string | null; overrides?: { subject?: string | null; body?: string }; now?: Date }): Promise<boolean> {
  const current = await db.one<{ status: string }>('select status from proposed_actions where id = $1', [id])
  if (!current) return false
  if (current.status === 'proposed') { if (!(await approveAction(db, id, opts))) return false }
  else if (!['approved', 'queued', 'failed', 'unknown'].includes(current.status)) return false
  const r = await executeAction(db, id, { actorId: opts.actorId, now: opts.now })
  return r.ok && !r.noop
}

// ---------------------------------------------------------------- delivery lifecycle
/** Execute queued actions whose send_after has passed (contact windows). Called by the crons. */
export async function drainDueActions(db: Db, now = new Date()): Promise<{ executed: number; deferred: number; failed: number }> {
  const due = await db.query<{ id: string }>("select id from proposed_actions where status = 'queued' and (send_after is null or send_after <= $1) order by send_after limit 500", [now])
  const out = { executed: 0, deferred: 0, failed: 0 }
  for (const d of due) {
    const r = await executeAction(db, d.id, { actorId: null, now })
    if (r.deferred) out.deferred++; else if (r.ok) out.executed++; else out.failed++
  }
  if (due.length) log.info('actions.drained', out)
  return out
}

/** provider_accepted with no callback after the configured window -> 'unknown' (visible, retryable). */
export async function markUnknownDeliveries(db: Db, now = new Date(), afterMin = opsConfig.deliveryUnknownAfterMin): Promise<number> {
  const cutoff = new Date(now.getTime() - afterMin * 60_000)
  const rows = await db.query<{ id: string }>(
    "update proposed_actions set status = 'unknown', delivery_status = 'unknown' where status = 'attempted' and delivery_status = 'provider_accepted' and attempted_at <= $1 returning id", [cutoff])
  if (rows.length) log.info('actions.unknown', { count: rows.length })
  return rows.length
}

export type DeliveryOutcome = 'delivered' | 'failed' | 'undelivered' | 'bounced'

/** Twilio status callback / Resend delivery event -> delivery_status on the matching row. */
export async function recordDeliveryCallback(db: Db, providerMessageId: string, outcome: DeliveryOutcome, reason?: string | null): Promise<boolean> {
  const delivered = outcome === 'delivered'
  const row = await db.one<{ id: string }>(
    delivered
      ? "update proposed_actions set status = 'delivered', delivery_status = 'delivered', delivered_at = now(), failure_reason = null where provider_message_id = $1 and status in ('attempted','unknown') returning id"
      : "update proposed_actions set status = 'failed', delivery_status = 'failed', failure_reason = $2 where provider_message_id = $1 and status in ('attempted','unknown') returning id",
    delivered ? [providerMessageId] : [providerMessageId, (reason ?? outcome).slice(0, 300)])
  log.info('action.delivery_callback', { matched: Boolean(row), outcome })
  return Boolean(row)
}

// ---------------------------------------------------------------- side effects
/**
 * Side effects that follow a send. Every path behaves the same. When the send was simulated the effect
 * is still applied (so the demo flow continues) but the resulting row is tagged simulated = true, which
 * isRealOutcome() excludes from every count.
 */
async function applyEffect(db: Db, a: ProposedActionRow, opts: { simulated: boolean }) {
  const effect = a.payload?.effect as string | undefined
  const p = a.payload ?? {}
  const sim = opts.simulated
  switch (effect) {
    case 'shift_offer_sent':
      await db.query("update shift_offers set sent_at = now(), status = 'sent', simulated = $3 where shift_id = $1 and aide_id = $2", [p.shift_id, p.aide_id, sim])
      break
    case 'referral_replied':
      await db.query(`update referrals set first_response_at = coalesce(first_response_at, now()), responded_by = coalesce(responded_by, 'deploi'), simulated = $3,
        capacity_confirmed_at = case when $2::boolean then coalesce(capacity_confirmed_at, now()) else capacity_confirmed_at end,
        intake_started_at = case when $2::boolean then coalesce(intake_started_at, now()) else intake_started_at end,
        status = case when $2::boolean then 'intake' else 'declined' end where id = $1`, [p.referral_id, Boolean(p.can_serve), sim])
      break
    case 'applicant_screen_sent':
      await db.query("update applicants set screen_state = 'q1', simulated = $2 where id = $1 and screen_state = 'idle'", [p.applicant_id, sim])
      break
    case 'applicant_interview_booked':
      await db.query("update applicants set interview_at = $2, status = 'interview_booked', simulated = $3 where id = $1", [p.applicant_id, p.interview_at, sim])
      break
    case 'retention_checkin_sent':
      await db.query("update retention_checkins set status = 'sent', simulated = $2 where id = $1", [p.checkin_id, sim])
      break
    default:
      break
  }
}
