/**
 * Shared worker runner. Every worker proposes; proposals land in proposed_actions
 * with status "proposed". They are sent only when a staff user approves them or
 * when the agency's per-worker auto_send toggle is ON (default OFF for everything).
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { sendEmail } from '../adapters/email'
import { sendSms } from '../adapters/sms'
import type { AgencyRow, Proposal, WorkerDef, WorkerName } from './types'

const registry = new Map<WorkerName, WorkerDef>()
export function registerWorker(def: WorkerDef) { registry.set(def.name, def) }
export function getWorker(name: WorkerName) { return registry.get(name) }
export function listWorkers() { return [...registry.values()] }

export type ProposedActionRow = {
  id: string; agency_id: string; worker: WorkerName; kind: 'email' | 'sms' | 'task'; to_ref: string | null
  subject: string | null; body: string; payload: Record<string, unknown>; status: string; dedupe_key: string | null
  created_at: string; send_after: string | null
}

export async function loadAgency(db: Db, agencyId: string): Promise<AgencyRow | null> {
  return db.one<AgencyRow>('select id, name, timezone, capacity_rules, radius_miles, interview_slots, auto_send from agencies where id = $1', [agencyId])
}

export type RunSummary = { worker: WorkerName; agency_id: string; dry_run: boolean; proposed: number; inserted: number; sent: number; errors: number; run_id: string }

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
      const r = await db.one<{ id: string }>(
        `insert into proposed_actions (agency_id, agency_name, worker, kind, to_ref, subject, body, payload, status, dedupe_key, send_after)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9,$10)
         on conflict (dedupe_key) do nothing returning id`,
        [agencyId, agency.name, name, p.kind, p.to_ref, p.subject ?? null, p.body, JSON.stringify(p.payload ?? {}), p.dedupe_key, p.send_after ?? null])
      if (r) { inserted++; insertedIds.push(r.id) }
    }
    let sent = 0
    if (!dryRun && agency.auto_send?.[name] === true) {
      for (const id of insertedIds) {
        const ok = await sendProposedAction(db, id, { actorId: null })
        if (ok) sent++; else errors++
      }
    }
    const summary = { worker: name, agency_id: agencyId, dry_run: dryRun, proposed: proposals.length, inserted, sent, errors, run_id: run!.id }
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

/**
 * Send one proposed action (approval path or auto-send). Applies the worker's
 * side effect described in payload.effect after a successful send.
 */
export async function sendProposedAction(db: Db, id: string, opts: { actorId: string | null; overrides?: { subject?: string | null; body?: string } }): Promise<boolean> {
  const a = await db.one<ProposedActionRow>("select * from proposed_actions where id = $1 and status in ('proposed','approved') for update", [id])
  if (!a) return false
  const subject = opts.overrides?.subject ?? a.subject
  const body = opts.overrides?.body ?? a.body
  const targets = await resolveRecipient(db, a.agency_id, a.to_ref, a.kind)
  let ok = true
  if (a.kind === 'email') {
    if (!targets.length) ok = false
    else ok = (await sendEmail({ to: targets, subject: subject ?? '(no subject)', text: body })).ok
  } else if (a.kind === 'sms') {
    if (!targets.length) ok = false
    else for (const t of targets) ok = (await sendSms({ to: t, body })).ok && ok
  }
  if (!ok) {
    log.warn('action.send.failed', { id, worker: a.worker, kind: a.kind, targets: targets.length })
    return false
  }
  await db.query("update proposed_actions set status = 'sent', sent_at = now(), decided_at = coalesce(decided_at, now()), decided_by = coalesce(decided_by, $2), subject = $3, body = $4 where id = $1", [id, opts.actorId, subject, body])
  await applyEffect(db, a)
  return true
}

/** Side effects that must follow a real send. Kept here so every path (approve, auto-send) behaves the same. */
async function applyEffect(db: Db, a: ProposedActionRow) {
  const effect = a.payload?.effect as string | undefined
  const p = a.payload ?? {}
  switch (effect) {
    case 'shift_offer_sent':
      await db.query("update shift_offers set sent_at = now(), status = 'sent' where shift_id = $1 and aide_id = $2", [p.shift_id, p.aide_id])
      break
    case 'referral_replied':
      await db.query(`update referrals set first_response_at = coalesce(first_response_at, now()), responded_by = coalesce(responded_by, 'deploi'),
        capacity_confirmed_at = case when $2::boolean then coalesce(capacity_confirmed_at, now()) else capacity_confirmed_at end,
        intake_started_at = case when $2::boolean then coalesce(intake_started_at, now()) else intake_started_at end,
        status = case when $2::boolean then 'intake' else 'declined' end where id = $1`, [p.referral_id, Boolean(p.can_serve)])
      break
    case 'applicant_screen_sent':
      await db.query("update applicants set screen_state = 'q1' where id = $1 and screen_state = 'idle'", [p.applicant_id])
      break
    case 'applicant_interview_booked':
      await db.query("update applicants set interview_at = $2, status = 'interview_booked' where id = $1", [p.applicant_id, p.interview_at])
      break
    case 'retention_checkin_sent':
      await db.query("update retention_checkins set status = 'sent' where id = $1", [p.checkin_id])
      break
    default:
      break
  }
}
