/**
 * Pilot measures computed from existing tables with explicit denominators and methods.
 * Each measure is a pure `compute(rows, period)` over synthetic-testable rows plus a `load` that
 * reads the rows for one agency and period. Every result carries value, numerator, denominator,
 * sample_size, method and a missing_data_note.
 *
 * Never-count rules (tested in tests/pilots/metrics.test.ts):
 *  - interviews_booked counts interview_at only; a hire is not a booking
 *  - shifts_confirmed_filled counts status = 'filled' only; outreach (offers, YES replies) never counts
 *  - exception_resolution_time counts corrected_at only; detection is never recovered payment
 *  - failed_actions and human_review_rate treat only attempted|delivered|failed|unknown as sent;
 *    proposed/approved/queued, simulated = true and any unknown status are never "sent"
 *  - human_review_rate counts a decision as human only when decided_by is a person
 */
import type { Db } from '../db'

export type Period = { start: string; end: string } // ISO dates, inclusive start, exclusive end+1day
export type Measurement = {
  key: string
  label: string
  unit: string
  value: number | null
  numerator: number | null
  denominator: number | null
  sample_size: number
  method: string
  missing_data_note: string | null
}

const ms = (iso: string | Date | null | undefined) => (iso ? new Date(iso).getTime() : NaN)
/** node-pg returns `date` columns as local-midnight Date objects; keep every period boundary as YYYY-MM-DD. */
export function ymdOf(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  return String(v).slice(0, 10)
}
const startMs = (p: Period) => Date.parse(p.start + 'T00:00:00Z')
const endMs = (p: Period) => Date.parse(p.end + 'T00:00:00Z') + 86400e3
export const inPeriod = (iso: string | Date | null | undefined, p: Period) => { const t = ms(iso); return Number.isFinite(t) && t >= startMs(p) && t < endMs(p) }

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round = (n: number | null, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)

/** proposed_actions statuses that mean a send was attempted (ops stream's state set). */
export const SENT_STATUSES = new Set(['attempted', 'delivered', 'failed', 'unknown'])
export type ActionRow = { status: string; simulated?: boolean | null; decided_by?: string | null; decided_at?: string | null; payload?: Record<string, unknown> | null; created_at?: string | null }
export const wasSent = (a: ActionRow) => SENT_STATUSES.has(a.status) && a.simulated !== true
export const wasDecided = (a: ActionRow) => a.status !== 'proposed' && Boolean(a.decided_at)

// ---------------------------------------------------------------- row types
export type ReferralRow = { received_at: string | null; first_response_at: string | null; intake_started_at: string | null; followup_7_at: string | null }
export type ApplicantRow = { applied_at: string | null; interview_at: string | null; status: string }
export type ShiftRow = { status: string; open_since: string | null; starts_at: string | null; filled_at: string | null; offers?: { status?: string | null; response?: string | null }[] }
export type ExceptionRow = { status: string; opened_at: string | null; corrected_at: string | null; claim_status?: string | null }

// ---------------------------------------------------------------- compute
export function referralResponseTime(rows: ReferralRow[], p: Period): Measurement {
  const received = rows.filter(r => inPeriod(r.received_at, p))
  const answered = received.filter(r => r.first_response_at && ms(r.first_response_at) >= ms(r.received_at))
  const minutes = answered.map(r => (ms(r.first_response_at) - ms(r.received_at)) / 60e3)
  return {
    key: 'referral_response_time', label: 'Median time to first response', unit: 'minutes',
    value: round(median(minutes), 1), numerator: answered.length, denominator: received.length, sample_size: answered.length,
    method: 'Median of (first_response_at − received_at) in minutes over referrals received in the period. Denominator: referrals received.',
    missing_data_note: received.length === 0 ? 'No referrals received in the period.' : answered.length < received.length ? `${received.length - answered.length} referral(s) had no first response and are excluded from the median.` : null,
  }
}

export function followupCompletion(rows: ReferralRow[], p: Period): Measurement {
  const cutoff = endMs(p) - 7 * 86400e3
  const eligible = rows.filter(r => r.intake_started_at && inPeriod(r.intake_started_at, p) && ms(r.intake_started_at) <= cutoff)
  const done = eligible.filter(r => r.followup_7_at)
  return {
    key: 'followup_completion', label: 'Follow-up completion', unit: 'ratio',
    value: eligible.length ? round(done.length / eligible.length) : null, numerator: done.length, denominator: eligible.length, sample_size: eligible.length,
    method: 'Referrals with a sent 7-day follow-up ÷ referrals that reached intake in the period at least 7 days before period end.',
    missing_data_note: eligible.length === 0 ? 'No referrals reached intake early enough in the period.' : null,
  }
}

export function interviewsBooked(rows: ApplicantRow[], p: Period): Measurement {
  const received = rows.filter(r => inPeriod(r.applied_at, p))
  const booked = received.filter(r => Boolean(r.interview_at)) // status alone (interview_booked, hired) never counts
  return {
    key: 'interviews_booked', label: 'Interviews booked', unit: 'ratio',
    value: received.length ? round(booked.length / received.length) : null, numerator: booked.length, denominator: received.length, sample_size: received.length,
    method: 'Applicants with interview_at set ÷ applicants received in the period. Bookings are not hires; a hire without a booking is not counted.',
    missing_data_note: received.length === 0 ? 'No applicants received in the period.' : null,
  }
}

export function shiftsConfirmedFilled(rows: ShiftRow[], p: Period): Measurement {
  const open = rows.filter(r => r.open_since && inPeriod(r.open_since, p))
  const filled = open.filter(r => r.status === 'filled') // offers sent or accepted never count
  return {
    key: 'shifts_confirmed_filled', label: 'Shifts confirmed filled', unit: 'ratio',
    value: open.length ? round(filled.length / open.length) : null, numerator: filled.length, denominator: open.length, sample_size: open.length,
    method: 'Shifts with status filled (agency-confirmed in the scheduler) ÷ shifts that became open in the period. Outreach alone is not a fill.',
    missing_data_note: open.length === 0 ? 'No shifts became open in the period.' : null,
  }
}

export function exceptionResolutionTime(rows: ExceptionRow[], p: Period): Measurement {
  const corrected = rows.filter(r => r.status === 'corrected' && r.corrected_at && inPeriod(r.corrected_at, p) && r.opened_at)
  const days = corrected.map(r => (ms(r.corrected_at) - ms(r.opened_at)) / 86400e3)
  const detectedOnly = rows.filter(r => r.status !== 'corrected' && inPeriod(r.opened_at, p)).length
  return {
    key: 'exception_resolution_time', label: 'Median days to resolve an exception', unit: 'days',
    value: round(median(days), 1), numerator: corrected.length, denominator: corrected.length, sample_size: corrected.length,
    method: 'Median of (corrected_at − opened_at) in days over exceptions corrected in the period. Detection is not resolution and is never recovered payment.',
    missing_data_note: corrected.length === 0 ? `No exceptions were corrected in the period${detectedOnly ? ` (${detectedOnly} detected, still open)` : ''}.` : null,
  }
}

export function staffHandlingTime(): Measurement {
  return {
    key: 'staff_handling_time', label: 'Staff handling time', unit: 'minutes per item',
    value: null, numerator: null, denominator: null, sample_size: 0,
    method: 'Manual entry: minutes a named person spent per handled item, recorded by the review owner.',
    missing_data_note: 'Manual entry required; nothing is computed.',
  }
}

export function failedActions(rows: ActionRow[], p: Period): Measurement {
  const inP = rows.filter(r => inPeriod(r.created_at ?? null, p))
  const sent = inP.filter(wasSent)
  const failed = sent.filter(r => r.status === 'failed')
  const simulated = inP.filter(r => r.simulated === true).length
  return {
    key: 'failed_actions', label: 'Failed actions', unit: 'ratio',
    value: sent.length ? round(failed.length / sent.length) : null, numerator: failed.length, denominator: sent.length, sample_size: sent.length,
    method: 'Actions with status failed ÷ actions attempted (attempted, delivered, failed, unknown). Proposed, approved, queued, simulated and unknown statuses are not sends.',
    missing_data_note: sent.length === 0 ? `No actions were attempted in the period${simulated ? ` (${simulated} simulated, excluded)` : ''}.` : simulated ? `${simulated} simulated action(s) excluded.` : null,
  }
}

export function correctionsRequired(rows: ActionRow[], p: Period): Measurement {
  const decided = rows.filter(r => inPeriod(r.created_at ?? null, p) && wasDecided(r))
  const corrected = decided.filter(r => r.payload?.edited === true)
  return {
    key: 'corrections_required', label: 'Corrections required', unit: 'ratio',
    value: decided.length ? round(corrected.length / decided.length) : null, numerator: corrected.length, denominator: decided.length, sample_size: decided.length,
    method: 'Decided actions whose text a person edited before approval (payload.edited) ÷ decided actions.',
    missing_data_note: decided.length === 0 ? 'No actions were decided in the period.' : 'Edits are counted only when the runtime marks payload.edited; unmarked edits read as zero.',
  }
}

export function humanReviewRate(rows: ActionRow[], p: Period): Measurement {
  const decided = rows.filter(r => inPeriod(r.created_at ?? null, p) && wasDecided(r))
  const human = decided.filter(r => Boolean(r.decided_by))
  return {
    key: 'human_review_rate', label: 'Human review rate', unit: 'ratio',
    value: decided.length ? round(human.length / decided.length) : null, numerator: human.length, denominator: decided.length, sample_size: decided.length,
    method: 'Actions decided by a named person (decided_by set) ÷ actions decided. Auto-sent actions have no person and count only in the denominator.',
    missing_data_note: decided.length === 0 ? 'No actions were decided in the period.' : null,
  }
}

// ---------------------------------------------------------------- loaders
async function hasColumn(db: Db, table: string, column: string) {
  const r = await db.one('select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3', ['public', table, column])
  return Boolean(r)
}

export async function loadActions(db: Db, agencyId: string, p: Period): Promise<ActionRow[]> {
  const simulatedCol = await hasColumn(db, 'proposed_actions', 'simulated')
  return db.query<ActionRow>(
    `select status, decided_by, decided_at, payload, created_at, ${simulatedCol ? 'simulated' : 'false as simulated'} from proposed_actions where agency_id = $1 and created_at >= $2::date and created_at < ($3::date + 1)`,
    [agencyId, p.start, p.end])
}

export const SUPPORTED: Record<string, { label: string; load: (db: Db, agencyId: string, p: Period) => Promise<Measurement> }> = {
  referral_response_time: { label: 'Median time to first response', load: async (db, a, p) => referralResponseTime(await db.query<ReferralRow>('select received_at, first_response_at, intake_started_at, followup_7_at from referrals where agency_id = $1 and received_at >= $2::date and received_at < ($3::date + 1)', [a, p.start, p.end]), p) },
  followup_completion: { label: 'Follow-up completion', load: async (db, a, p) => followupCompletion(await db.query<ReferralRow>('select received_at, first_response_at, intake_started_at, followup_7_at from referrals where agency_id = $1 and intake_started_at >= $2::date and intake_started_at < ($3::date + 1)', [a, p.start, p.end]), p) },
  interviews_booked: { label: 'Interviews booked', load: async (db, a, p) => interviewsBooked(await db.query<ApplicantRow>('select applied_at, interview_at, status from applicants where agency_id = $1 and applied_at >= $2::date and applied_at < ($3::date + 1)', [a, p.start, p.end]), p) },
  shifts_confirmed_filled: { label: 'Shifts confirmed filled', load: async (db, a, p) => shiftsConfirmedFilled(await db.query<ShiftRow>('select status, open_since, starts_at, filled_at from shifts where agency_id = $1 and open_since >= $2::date and open_since < ($3::date + 1)', [a, p.start, p.end]), p) },
  exception_resolution_time: { label: 'Median days to resolve an exception', load: async (db, a, p) => exceptionResolutionTime(await db.query<ExceptionRow>('select status, opened_at, corrected_at from evv_exceptions where agency_id = $1 and (opened_at >= $2::date or corrected_at >= $2::date) and opened_at < ($3::date + 1)', [a, p.start, p.end]), p) },
  staff_handling_time: { label: 'Staff handling time', load: async () => staffHandlingTime() },
  failed_actions: { label: 'Failed actions', load: async (db, a, p) => failedActions(await loadActions(db, a, p), p) },
  corrections_required: { label: 'Corrections required', load: async (db, a, p) => correctionsRequired(await loadActions(db, a, p), p) },
  human_review_rate: { label: 'Human review rate', load: async (db, a, p) => humanReviewRate(await loadActions(db, a, p), p) },
}

/** Generic measures every pilot reports in addition to the service's own success measures. */
export const GENERIC_KEYS = ['staff_handling_time', 'failed_actions', 'corrections_required', 'human_review_rate'] as const

export function unsupported(key: string, label: string): Measurement {
  return { key, label, unit: '', value: null, numerator: null, denominator: null, sample_size: 0, method: 'Not computed by this build.', missing_data_note: 'This measure has no automated computation yet; record it manually or treat it as missing.' }
}

export async function computeMeasure(db: Db, key: string, label: string, agencyId: string, p: Period): Promise<Measurement> {
  const def = SUPPORTED[key]
  if (!def) return unsupported(key, label)
  return def.load(db, agencyId, p)
}
