/** Nightly: aide credential expiries at 30/14/7 days → SMS to the aide, email to the admin. */
import type { Db } from '@/lib/db'
import { initials, type AgencyRow, type Proposal, type WorkerDef } from '@/lib/workers/types'
import { daysBetween } from './authorization_watch'

export type Credential = { type: string; expires_on: string }
export type AideCredRow = { id: string; first_name: string; last_name: string; phone: string | null; credentials: Credential[] }
export type CredExpiry = { aide: AideCredRow; cred: Credential; daysLeft: number; threshold: 30 | 14 | 7 }

export function credentialExpiries(aides: AideCredRow[], now: Date): CredExpiry[] {
  const out: CredExpiry[] = []
  for (const a of aides) {
    for (const c of a.credentials ?? []) {
      if (!c?.expires_on) continue
      const d = daysBetween(now, c.expires_on)
      if (d < 0 || d > 30) continue
      const threshold = d <= 7 ? 7 : d <= 14 ? 14 : 30
      out.push({ aide: a, cred: c, daysLeft: d, threshold })
    }
  }
  return out.sort((x, y) => x.daysLeft - y.daysLeft)
}

export function buildCredentialProposals(e: CredExpiry): Proposal[] {
  const who = `Aide ${initials(e.aide.first_name, e.aide.last_name)}`
  const base = `cred:${e.aide.id}:${e.cred.type}:${e.cred.expires_on}:${e.threshold}`
  return [
    {
      kind: 'sms', to_ref: `aide:${e.aide.id}`,
      body: `Hi ${e.aide.first_name}, your ${e.cred.type} expires on ${e.cred.expires_on} (${e.daysLeft} days). Please send the renewal to the office so you can keep your shifts. Reply with any questions.`,
      payload: { aide_id: e.aide.id, credential: e.cred.type, expires_on: e.cred.expires_on, to_label: who, threshold: e.threshold },
      dedupe_key: `${base}:aide`,
    },
    {
      kind: 'email', to_ref: 'admin',
      subject: `${e.cred.type} lapses in ${e.daysLeft} days · ${who}`,
      body: `${who}: ${e.cred.type} expires ${e.cred.expires_on} (${e.daysLeft} days). The aide has been reminded by text. If it lapses, visits by this aide cannot be billed.`,
      payload: { aide_id: e.aide.id, credential: e.cred.type, expires_on: e.cred.expires_on, to_label: 'Admin', about: who, threshold: e.threshold },
      dedupe_key: `${base}:admin`,
    },
  ]
}

export const credentialTracking: WorkerDef = {
  name: 'credential_tracking', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const aides = await db.query<AideCredRow>('select id, first_name, last_name, phone, credentials from aides where agency_id = $1 and active', [agency.id])
    return credentialExpiries(aides, now).flatMap(buildCredentialProposals)
  },
}
