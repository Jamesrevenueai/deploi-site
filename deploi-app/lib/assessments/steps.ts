/** Step definitions for the two traces. Order matters: elapsed time is between consecutive steps. */
export type Trace = 'referral' | 'visit'
export type StepDef = { key: string; title: string; prompt: string; outcome?: { label: string; options: string[] } }

export const REFERRAL_STEPS: StepDef[] = [
  { key: 'referral_received', title: 'Referral received', prompt: 'When, how (email, fax, phone, portal) and from whom?' },
  { key: 'first_response', title: 'First response', prompt: 'When did someone reply, and who?' },
  { key: 'capacity_confirmed', title: 'Capacity confirmed', prompt: 'When was the referrer told you could take the client?' },
  { key: 'intake_started', title: 'Intake started', prompt: 'Packet sent, assessment scheduled.' },
  { key: 'care_started', title: 'Care started', prompt: 'First visit completed.' },
  { key: 'followup_to_referrer', title: 'Follow-up to referrer', prompt: 'Did anyone tell the referrer care started?' },
]

export const VISIT_STEPS: StepDef[] = [
  { key: 'visit_scheduled', title: 'Visit scheduled', prompt: 'Scheduled in the scheduler, aide assigned.' },
  { key: 'aide_confirmed', title: 'Aide confirmed', prompt: 'Aide acknowledged the shift.' },
  { key: 'clock_in', title: 'Clock-in (EVV)', prompt: 'EVV clock-in recorded.' },
  { key: 'clock_out', title: 'Clock-out (EVV)', prompt: 'EVV clock-out recorded.' },
  { key: 'exception_raised', title: 'Exception raised?', prompt: 'Did the EVV vendor flag the visit?', outcome: { label: 'Exception', options: ['no', 'yes'] } },
  { key: 'corrected_in_window', title: 'Corrected within window?', prompt: 'Was it fixed before the state correction window closed?', outcome: { label: 'Corrected', options: ['n/a', 'yes', 'no'] } },
  { key: 'claim_submitted', title: 'Claim submitted', prompt: 'Claim sent to the payer.' },
  { key: 'paid_or_denied', title: 'Paid or denied', prompt: 'Outcome and, if denied, the reason.', outcome: { label: 'Outcome', options: ['paid', 'denied'] } },
]

export const STEPS: Record<Trace, StepDef[]> = { referral: REFERRAL_STEPS, visit: VISIT_STEPS }
export const TRACE_TITLES: Record<Trace, string> = { referral: 'Referral trace', visit: 'Visit trace' }

export type TraceStepRow = {
  id: string
  trace: Trace
  step_key: string
  step_order: number
  occurred_at: string | null
  who: string | null
  what_went_wrong: string | null
  outcome: string | null
  note: string | null
}

export function elapsedLabel(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (!Number.isFinite(ms)) return null
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const h = abs / 3600e3
  if (h < 1) return `${sign}${Math.round(abs / 60e3)} min`
  if (h < 48) return `${sign}${Math.round(h * 10) / 10} h`
  return `${sign}${Math.round(h / 24)} d`
}

export function hoursBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  return Number.isFinite(ms) ? ms / 3600e3 : null
}

/** What the traces tell the leak calculator. */
export function traceFacts(steps: TraceStepRow[]) {
  const by = (t: Trace, k: string) => steps.find(s => s.trace === t && s.step_key === k)
  const referral_response_hours = hoursBetween(by('referral', 'referral_received')?.occurred_at, by('referral', 'first_response')?.occurred_at)
  const paid = by('visit', 'paid_or_denied')?.outcome ?? null
  const exc = by('visit', 'exception_raised')?.outcome ?? null
  const corrected = by('visit', 'corrected_in_window')?.outcome ?? null
  return {
    referral_response_hours,
    visit_denied: paid ? paid === 'denied' : null,
    exception_uncorrected: exc ? exc === 'yes' && corrected === 'no' : null,
  }
}
