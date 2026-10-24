/** Gather the live facts readiness needs for one engagement. */
import type { Db } from '../db'
import type { ReadinessFacts } from './readiness'
import { listChecklist, ensureChecklist } from './checklist'
import { computeReadiness } from './readiness'

export async function gatherFacts(db: Db, engagementId: string, agencyId: string): Promise<ReadinessFacts> {
  const baa = await db.one<{ baa_signed_at: string | null }>('select baa_signed_at from agencies where id = $1', [agencyId])
  const pilot = await db.one<{ id: string; starts_on: string | null; ends_on: string | null; primary_metric_key: string | null; decision: string | null }>(
    'select id, starts_on, ends_on, primary_metric_key, decision from pilots where engagement_id = $1', [engagementId])
  let baselineMeasurements = 0
  if (pilot) {
    const n = await db.one<{ n: string }>("select count(*)::text as n from pilot_measurements where pilot_id = $1 and period = 'baseline'", [pilot.id])
    baselineMeasurements = Number(n?.n ?? 0)
  }
  return {
    baaSignedAt: baa?.baa_signed_at ?? null,
    pilot: pilot ? { hasDates: Boolean(pilot.starts_on && pilot.ends_on), hasPrimaryMetric: Boolean(pilot.primary_metric_key), decision: pilot.decision, baselineMeasurements } : null,
  }
}

export async function engagementReadiness(db: Db, engagementId: string, agencyId: string) {
  await ensureChecklist(db, engagementId, agencyId)
  const rows = await listChecklist(db, engagementId)
  const facts = await gatherFacts(db, engagementId, agencyId)
  return { rows, facts, readiness: computeReadiness(rows, facts) }
}
