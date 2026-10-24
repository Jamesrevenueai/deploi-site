import type { Db } from '../db'

export type WorkerName =
  | 'authorization_watch' | 'credential_tracking' | 'open_shift_fill'
  | 'referral_response' | 'applicant_screening' | 'retention_checkins'

export const WORKER_NAMES: WorkerName[] = [
  'authorization_watch', 'credential_tracking', 'open_shift_fill', 'referral_response', 'applicant_screening', 'retention_checkins',
]

export const WORKER_LABELS: Record<WorkerName, string> = {
  authorization_watch: 'Authorization watch',
  credential_tracking: 'Credential tracking',
  open_shift_fill: 'Open-shift fill',
  referral_response: 'Referral response',
  applicant_screening: 'Applicant screening',
  retention_checkins: 'Retention check-ins',
}

export type ProposalKind = 'email' | 'sms' | 'task'

/** What a worker wants to send or do. Nothing leaves until approved or auto-send is on. */
export type Proposal = {
  kind: ProposalKind
  /** recipient descriptor: scheduler | admin | aide:<id> | family:<client_id> | referrer:<referral_id> | applicant:<id> */
  to_ref: string
  subject?: string
  body: string
  payload?: Record<string, unknown>
  dedupe_key: string
  /** do not materialize before this time (follow-ups) */
  send_after?: Date | null
  /** time-sensitive actions: executeAction refuses the row after this (undefined = derive from payload / defaults) */
  expires_at?: Date | null
}

export type AgencyRow = {
  id: string
  name: string
  timezone: string
  capacity_rules: CapacityRules
  radius_miles: number
  interview_slots: InterviewSlot[]
  auto_send: Partial<Record<WorkerName, boolean>>
}

export type CapacityRules = {
  counties?: string[]
  services?: string[]
  hours?: { start: string; end: string }
  max_new_clients_per_week?: number
}

export type InterviewSlot = { weekday: number; time: string }

export type WorkerDef = {
  name: WorkerName
  /** runs on the nightly cron */
  nightly: boolean
  propose: (db: Db, agency: AgencyRow, now: Date) => Promise<Proposal[]>
}

/** "Client J.D." style label: never a full name in a staff list. */
export function initials(first: string | null | undefined, last: string | null | undefined) {
  const a = (first ?? '').trim()[0]
  const b = (last ?? '').trim()[0]
  return `${a ? a.toUpperCase() + '.' : ''}${b ? b.toUpperCase() + '.' : ''}` || '—'
}
