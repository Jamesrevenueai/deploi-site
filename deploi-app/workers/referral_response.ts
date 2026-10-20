/**
 * Referral response: decide capacity from the agency's rules, draft a reply
 * (local Ollama lane only; template fallback), propose it, and queue 7/30-day follow-ups.
 */
import type { Db } from '@/lib/db'
import { draftReferralReply } from '@/lib/phi'
import { LlmUnavailable } from '@/lib/llm/types'
import type { AgencyRow, CapacityRules, Proposal, WorkerDef } from '@/lib/workers/types'

export type ReferralRow = { id: string; source_name: string | null; source_org: string | null; source_email: string | null; county: string | null; service: string | null; hours_per_week: number | null; received_at: string; first_response_at: string | null; care_started_at: string | null; status: string }

export type CapacityDecision = { canServe: boolean; reasons: string[] }

export function decideCapacity(rules: CapacityRules, r: { county: string | null; service: string | null; received_at?: string }, tz = 'America/New_York'): CapacityDecision {
  const reasons: string[] = []
  if (rules.counties?.length && r.county && !rules.counties.map(c => c.toLowerCase()).includes(r.county.toLowerCase())) reasons.push(`county ${r.county} not served`)
  if (rules.services?.length && r.service && !rules.services.includes(r.service)) reasons.push(`service ${r.service} not offered`)
  if (rules.hours && r.received_at) {
    const hm = new Date(r.received_at).toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    if (hm < rules.hours.start || hm > rules.hours.end) reasons.push('received outside intake hours (reply first thing)')
  }
  const hard = reasons.filter(x => !x.startsWith('received outside'))
  return { canServe: hard.length === 0, reasons }
}

export function templateReply(opts: { referrerName: string | null; service: string | null; county: string | null; canServe: boolean; agencyName: string }) {
  const hi = `Hi ${opts.referrerName ?? 'there'},`
  return opts.canServe
    ? `${hi} thank you for the referral. We have capacity for ${opts.service ?? 'this service'} in ${opts.county ?? 'this county'} and are starting intake today; we will confirm the start of care with you as soon as it is scheduled. — ${opts.agencyName}`
    : `${hi} thank you for thinking of us. We cannot cover ${opts.service ?? 'this service'} in ${opts.county ?? 'that county'} right now, so please route this one to a partner agency; we will let you know as soon as that changes. — ${opts.agencyName}`
}

export async function draftReply(opts: Parameters<typeof templateReply>[0]) {
  try {
    const r = await draftReferralReply(opts)
    if (r.mocked || !r.text.trim()) return { text: templateReply(opts), source: 'template' as const }
    return { text: r.text.trim(), source: 'ollama' as const }
  } catch (e) {
    if (e instanceof LlmUnavailable) return { text: templateReply(opts), source: 'template' as const }
    throw e
  }
}

export function followUpProposals(r: ReferralRow, agencyName: string): Proposal[] {
  const base = r.first_response_at ?? r.received_at
  const after = (days: number) => new Date(new Date(base).getTime() + days * 86400e3)
  return [
    { kind: 'email', to_ref: `referrer:${r.id}`, subject: `Update on the referral you sent ${agencyName}`, body: `Hi ${r.source_name ?? 'there'}, a quick 7-day update: intake is ${r.care_started_at ? 'complete and care has started' : 'in progress'} for the client you referred. Thank you again. — ${agencyName}`, payload: { referral_id: r.id, to_label: 'Referrer', day: 7 }, dedupe_key: `ref:${r.id}:d7`, send_after: after(7) },
    { kind: 'email', to_ref: `referrer:${r.id}`, subject: `30 days in: the client you referred to ${agencyName}`, body: `Hi ${r.source_name ?? 'there'}, 30 days in: care is ${r.care_started_at ? 'under way and going well' : 'being scheduled'}. We would be glad to take your next referral. — ${agencyName}`, payload: { referral_id: r.id, to_label: 'Referrer', day: 30 }, dedupe_key: `ref:${r.id}:d30`, send_after: after(30) },
  ]
}

export const referralResponse: WorkerDef = {
  name: 'referral_response', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const proposals: Proposal[] = []
    const refs = await db.query<ReferralRow>('select id, source_name, source_org, source_email, county, service, hours_per_week, received_at, first_response_at, care_started_at, status from referrals where agency_id = $1 and status not in ($2, $3)', [agency.id, 'lost', 'declined'])
    for (const r of refs) {
      if (!r.first_response_at) {
        const d = decideCapacity(agency.capacity_rules ?? {}, r, agency.timezone)
        const draft = await draftReply({ referrerName: r.source_name, service: r.service, county: r.county, canServe: d.canServe, agencyName: agency.name })
        proposals.push({
          kind: 'email', to_ref: `referrer:${r.id}`,
          subject: d.canServe ? `Referral accepted · intake starting · ${agency.name}` : `Referral · ${agency.name}`,
          body: draft.text,
          payload: { effect: 'referral_replied', referral_id: r.id, can_serve: d.canServe, reasons: d.reasons, draft_source: draft.source, to_label: `Referrer (${r.source_org ?? 'unknown org'})` },
          dedupe_key: `ref:${r.id}:reply`,
        })
      }
      if (r.first_response_at && r.status !== 'declined') proposals.push(...followUpProposals(r, agency.name).filter(p => !p.send_after || p.send_after <= now))
    }
    return proposals
  },
}
