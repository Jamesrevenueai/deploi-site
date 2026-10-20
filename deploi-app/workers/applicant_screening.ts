/** Applicant screening: 4-question SMS screen, scoring, interview slot from the agency calendar. */
import type { Db } from '@/lib/db'
import { initials, type AgencyRow, type InterviewSlot, type Proposal, type WorkerDef } from '@/lib/workers/types'

export const SCREEN_QUESTIONS = [
  { key: 'stna', text: 'Q1 of 4: Do you hold a current STNA or HHA certificate? (yes/no)' },
  { key: 'drives', text: 'Q2 of 4: Do you have a reliable car and a valid license? (yes/no)' },
  { key: 'availability', text: 'Q3 of 4: When can you work? (weekdays / evenings / weekends / any)' },
  { key: 'county', text: 'Q4 of 4: Which county do you live in?' },
] as const
export type ScreenState = 'idle' | 'q1' | 'q2' | 'q3' | 'q4' | 'complete'
export type ScreenAnswers = { stna?: boolean; drives?: boolean; availability?: string; county?: string }

const yes = (t: string) => /^\s*(y|yes|yeah|yep|si|sure)\b/i.test(t)

export function nextScreenState(state: ScreenState, answers: ScreenAnswers, text: string): { state: ScreenState; answers: ScreenAnswers; reply: string | null } {
  const a = { ...answers }
  switch (state) {
    case 'q1': a.stna = yes(text); return { state: 'q2', answers: a, reply: SCREEN_QUESTIONS[1].text }
    case 'q2': a.drives = yes(text); return { state: 'q3', answers: a, reply: SCREEN_QUESTIONS[2].text }
    case 'q3': a.availability = text.trim().toLowerCase().slice(0, 40); return { state: 'q4', answers: a, reply: SCREEN_QUESTIONS[3].text }
    case 'q4': a.county = text.trim().replace(/\s*county$/i, '').slice(0, 40); return { state: 'complete', answers: a, reply: 'Thanks! That is everything. We will text you an interview time shortly.' }
    default: return { state, answers: a, reply: null }
  }
}

export function scoreAnswers(a: ScreenAnswers, servedCounties: string[] = []): number {
  let s = 0
  if (a.stna) s++
  if (a.drives) s++
  if (a.availability && /any|weekday|weekend|evening/.test(a.availability)) s++
  if (a.county && (!servedCounties.length || servedCounties.map(c => c.toLowerCase()).includes(a.county.toLowerCase()))) s++
  return s
}

/** Next interview slot strictly after `now` (at least tomorrow), in the agency timezone. */
export function nextInterviewSlot(slots: InterviewSlot[], now: Date, tz = 'America/New_York'): Date | null {
  if (!slots?.length) return null
  const candidates: Date[] = []
  for (let d = 1; d <= 14; d++) {
    const day = new Date(now.getTime() + d * 86400e3)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(day)
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(p => p.type === 'weekday')!.value)
    for (const s of slots) {
      if (s.weekday !== wd) continue
      const y = parts.find(p => p.type === 'year')!.value, m = parts.find(p => p.type === 'month')!.value, dd = parts.find(p => p.type === 'day')!.value
      // build the local time then convert via offset probe
      const naive = new Date(`${y}-${m}-${dd}T${s.time}:00Z`)
      const offsetMin = tzOffsetMinutes(naive, tz)
      candidates.push(new Date(naive.getTime() - offsetMin * 60e3))
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime())
  return candidates.find(c => c > now) ?? null
}

function tzOffsetMinutes(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date)
  const get = (t: string) => Number(f.find(p => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
  return (asUtc - date.getTime()) / 60e3
}

export type ApplicantRow = { id: string; first_name: string; last_name: string; phone: string | null; status: string; screen_state: ScreenState; screen_answers: ScreenAnswers; screen_score: number | null; interview_at: string | null }

export function buildScreenProposal(a: ApplicantRow): Proposal {
  return {
    kind: 'sms', to_ref: `applicant:${a.id}`,
    body: `Hi ${a.first_name}, thanks for applying! Four quick questions and we will book your interview. ${SCREEN_QUESTIONS[0].text}`,
    payload: { effect: 'applicant_screen_sent', applicant_id: a.id, to_label: `Applicant ${initials(a.first_name, a.last_name)}` },
    dedupe_key: `applicant:${a.id}:screen`,
  }
}

export function buildInterviewProposal(a: ApplicantRow, slot: Date, tz: string, score: number): Proposal {
  const when = slot.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return {
    kind: 'sms', to_ref: `applicant:${a.id}`,
    body: `Great news ${a.first_name}: we would like to interview you ${when}. Reply YES to confirm or tell us a better time.`,
    payload: { effect: 'applicant_interview_booked', applicant_id: a.id, interview_at: slot.toISOString(), score, to_label: `Applicant ${initials(a.first_name, a.last_name)}` },
    dedupe_key: `applicant:${a.id}:interview:${slot.toISOString().slice(0, 10)}`,
  }
}

export const applicantScreening: WorkerDef = {
  name: 'applicant_screening', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const proposals: Proposal[] = []
    const rows = await db.query<ApplicantRow>("select id, first_name, last_name, phone, status, screen_state, screen_answers, screen_score, interview_at from applicants where agency_id = $1 and status in ('new','screened')", [agency.id])
    for (const a of rows) {
      if (a.status === 'new' && a.screen_state === 'idle' && a.phone) proposals.push(buildScreenProposal(a))
      if (a.status === 'screened' && !a.interview_at) {
        const score = a.screen_score ?? scoreAnswers(a.screen_answers ?? {}, agency.capacity_rules?.counties ?? [])
        if (score >= 2) {
          const slot = nextInterviewSlot(agency.interview_slots ?? [], now, agency.timezone)
          if (slot) proposals.push(buildInterviewProposal(a, slot, agency.timezone, score))
        }
      }
    }
    return proposals
  },
}

/** Twilio reply from an applicant mid-screen. Returns the next question to send (as a proposal). */
export async function handleApplicantReply(db: Db, a: ApplicantRow & { agency_id: string }, text: string, servedCounties: string[]): Promise<{ handled: boolean; proposals: Proposal[] }> {
  if (!['q1', 'q2', 'q3', 'q4'].includes(a.screen_state)) return { handled: false, proposals: [] }
  const next = nextScreenState(a.screen_state, a.screen_answers ?? {}, text)
  const complete = next.state === 'complete'
  const score = complete ? scoreAnswers(next.answers, servedCounties) : null
  await db.query("update applicants set screen_state = $2, screen_answers = $3, screen_score = coalesce($4, screen_score), status = case when $5::boolean then 'screened' else status end where id = $1",
    [a.id, next.state, JSON.stringify(next.answers), score, complete])
  const proposals: Proposal[] = next.reply ? [{ kind: 'sms', to_ref: `applicant:${a.id}`, body: next.reply, payload: { applicant_id: a.id, to_label: `Applicant ${initials(a.first_name, a.last_name)}`, step: next.state }, dedupe_key: `applicant:${a.id}:${next.state}` }] : []
  return { handled: true, proposals }
}
