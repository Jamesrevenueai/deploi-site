/** Nightly: units used vs authorized per client; flag ≤15% remaining or expiry ≤30 days. */
import type { Db } from '@/lib/db'
import { initials, type AgencyRow, type Proposal, type WorkerDef } from '@/lib/workers/types'

export type AuthRow = { id: string; client_id: string; service_code: string; units_authorized: number; units_used: number; ends_on: string; first_name?: string; last_name?: string }
export type AuthFlag = { auth: AuthRow; remaining: number; pctRemaining: number; daysToEnd: number; reasons: ('low_units' | 'expiring')[] }

const DAY = 86400e3
export function daysBetween(from: Date, toYmd: string) {
  const to = new Date(toYmd + 'T00:00:00Z')
  const f = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  return Math.round((to.getTime() - f.getTime()) / DAY)
}

export function flagAuthorizations(rows: AuthRow[], now: Date, opts = { pct: 0.15, days: 30 }): AuthFlag[] {
  const out: AuthFlag[] = []
  for (const a of rows) {
    const remaining = a.units_authorized - a.units_used
    const pct = a.units_authorized > 0 ? remaining / a.units_authorized : 0
    const daysToEnd = daysBetween(now, a.ends_on)
    const reasons: AuthFlag['reasons'] = []
    if (pct <= opts.pct) reasons.push('low_units')
    if (daysToEnd >= 0 && daysToEnd <= opts.days) reasons.push('expiring')
    if (reasons.length) out.push({ auth: a, remaining, pctRemaining: pct, daysToEnd, reasons })
  }
  return out
}

export function buildAuthProposal(f: AuthFlag, now: Date): Proposal {
  const month = now.toISOString().slice(0, 7)
  const who = `Client ${initials(f.auth.first_name, f.auth.last_name)}`
  const why = f.reasons.map(r => r === 'low_units' ? `${f.remaining} of ${f.auth.units_authorized} units left (${Math.round(f.pctRemaining * 100)}%)` : `authorization ends in ${f.daysToEnd} days (${f.auth.ends_on})`).join('; ')
  return {
    kind: 'email', to_ref: 'scheduler',
    subject: `Re-auth needed: ${who} · ${f.auth.service_code}`,
    body: `${who} (${f.auth.service_code}): ${why}. Please start the re-authorization now so care never outruns the auth.`,
    payload: { authorization_id: f.auth.id, client_id: f.auth.client_id, to_label: 'Scheduler', about: who, reasons: f.reasons },
    dedupe_key: `auth:${f.auth.id}:${month}`,
  }
}

export const authorizationWatch: WorkerDef = {
  name: 'authorization_watch', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const rows = await db.query<AuthRow>(
      `select a.id, a.client_id, a.service_code, a.units_authorized, a.units_used, a.ends_on::text as ends_on, c.first_name, c.last_name
       from authorizations a join clients c on c.id = a.client_id where a.agency_id = $1 and a.ends_on >= current_date - 1`, [agency.id])
    return flagAuthorizations(rows, now).map(f => buildAuthProposal(f, now))
  },
}
