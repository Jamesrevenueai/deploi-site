/**
 * Simulated vs real outcomes. A send through a mock adapter is recorded as delivered + simulated;
 * the side effect it triggers (offer sent, referral replied, check-in sent, applicant screened) is kept
 * so the demo flows work, but the resulting row is tagged `simulated = true` and must never be counted
 * as a real outcome. Use isRealOutcome() in every metric, report and export that counts outcomes.
 */
import type { Db } from '../db'

export type Outcomeish = { simulated?: boolean | null } | null | undefined

/** true only for rows that were not produced by a simulated (mock-adapter) send */
export function isRealOutcome(row: Outcomeish): boolean {
  return Boolean(row) && row!.simulated !== true
}

export function countReal<T extends Outcomeish>(rows: T[]): number {
  return rows.filter(isRealOutcome).length
}

export type SimulatedSummary = { delivered: number; simulated: number; real: number }

/** For reports: how many delivered actions were simulated. Reports print "N simulated sends (not counted)". */
export async function simulatedSummary(db: Db, agencyId: string, since?: Date): Promise<SimulatedSummary> {
  const r = await db.one<{ delivered: string; simulated: string }>(
    `select count(*) filter (where status = 'delivered')::text as delivered,
            count(*) filter (where status = 'delivered' and simulated)::text as simulated
     from proposed_actions where agency_id = $1 ${since ? 'and delivered_at >= $2' : ''}`, since ? [agencyId, since] : [agencyId])
  const delivered = Number(r?.delivered ?? 0), simulated = Number(r?.simulated ?? 0)
  return { delivered, simulated, real: delivered - simulated }
}

export function simulatedReportLine(s: SimulatedSummary): string {
  if (!s.simulated) return 'No simulated sends.'
  return `${s.simulated} simulated send${s.simulated === 1 ? '' : 's'} (mock adapter, not counted as outcomes).`
}
