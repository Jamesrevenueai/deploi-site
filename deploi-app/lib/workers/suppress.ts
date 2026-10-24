/**
 * Suppression: pending actions (proposed | approved | queued) that became obsolete or unwanted are
 * moved to status 'suppressed' with a reason. Never deletes; the audit trail keeps the row.
 * The SQL triggers in migration 0023 cover record changes made from any code path; these helpers
 * cover the webhook paths where the change is known in process.
 */
import type { Db } from '../db'
import { log } from '../log'

export const PENDING = ['proposed', 'approved', 'queued'] as const

export type SuppressReason =
  | 'opt_out' | 'shift_filled' | 'shift_cancelled' | 'referral_answered' | 'referral_closed'
  | 'applicant_replied' | 'applicant_hired' | 'applicant_rejected' | 'checkin_answered' | 'referrer_replied' | 'superseded'

/** Suppress every pending SMS to one recipient descriptor (aide:<id> | applicant:<id> | family:<client_id>). */
export async function suppressSmsTo(db: Db, agencyId: string, toRef: string, reason: SuppressReason = 'opt_out'): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update proposed_actions set status = 'suppressed', suppressed_reason = $3, decided_at = coalesce(decided_at, now())
     where agency_id = $1 and kind = 'sms' and to_ref = $2 and status = any($4::text[]) returning id`, [agencyId, toRef, reason, [...PENDING]])
  log.info('actions.suppressed', { agency_id: agencyId, reason, count: rows.length })
  return rows.length
}

/** Suppress pending actions whose payload[key] = value, optionally sparing rows where payload[exceptKey] = exceptValue. */
export async function suppressByPayload(db: Db, agencyId: string, key: string, value: string, reason: SuppressReason, opts: { exceptKey?: string; exceptValue?: string; worker?: string; before?: Date } = {}): Promise<number> {
  const params: unknown[] = [agencyId, key, value, reason, [...PENDING]]
  let extra = ''
  if (opts.exceptKey) { params.push(opts.exceptKey, opts.exceptValue ?? ''); extra += ` and coalesce(payload ->> $${params.length - 1}, '') <> $${params.length}` }
  if (opts.worker) { params.push(opts.worker); extra += ` and worker = $${params.length}` }
  if (opts.before) { params.push(opts.before); extra += ` and created_at < $${params.length}` }
  const rows = await db.query<{ id: string }>(
    `update proposed_actions set status = 'suppressed', suppressed_reason = $4, decided_at = coalesce(decided_at, now())
     where agency_id = $1 and status = any($5::text[]) and payload ->> $2 = $3 ${extra} returning id`, params)
  log.info('actions.suppressed', { agency_id: agencyId, reason, count: rows.length })
  return rows.length
}

/** A filled shift retires every other pending offer for it. */
export const suppressShiftOffers = (db: Db, agencyId: string, shiftId: string, acceptedAideId: string | null) =>
  suppressByPayload(db, agencyId, 'shift_id', shiftId, 'shift_filled', { exceptKey: 'aide_id', exceptValue: acceptedAideId ?? '' })

/** An applicant who just replied makes earlier pending screening texts obsolete (the next question is proposed fresh). */
export const suppressApplicantFollowups = (db: Db, agencyId: string, applicantId: string, before: Date) =>
  suppressByPayload(db, agencyId, 'applicant_id', applicantId, 'applicant_replied', { worker: 'applicant_screening', before })

export const suppressReferralFollowups = (db: Db, agencyId: string, referralId: string, reason: SuppressReason = 'referrer_replied') =>
  suppressByPayload(db, agencyId, 'referral_id', referralId, reason)

/**
 * Opt-out: STOP from a phone number. Flips sms_consent off on every matching aide / applicant / client
 * (a number can legitimately appear in more than one table) and suppresses their pending texts.
 */
export async function recordOptOut(db: Db, phone: string): Promise<{ matched: number; suppressed: number }> {
  let matched = 0, suppressed = 0
  const tables: { table: string; ref: string; col: string }[] = [
    { table: 'aides', ref: 'aide', col: 'phone' }, { table: 'applicants', ref: 'applicant', col: 'phone' }, { table: 'clients', ref: 'family', col: 'family_phone' },
  ]
  for (const t of tables) {
    const rows = await db.query<{ id: string; agency_id: string }>(
      `update ${t.table} set sms_consent = false, sms_opt_out_at = now() where ${t.col} = $1 returning id, agency_id`, [phone])
    for (const r of rows) { matched++; suppressed += await suppressSmsTo(db, r.agency_id, `${t.ref}:${r.id}`, 'opt_out') }
  }
  log.info('sms.opt_out', { matched, suppressed })
  return { matched, suppressed }
}
