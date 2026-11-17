/** Test helper: plan limits live in the `plans` table (lib/plans/catalog.ts); change one and restore them all. */
import { admin } from '../../lib/db'
import { invalidatePlanCache } from '../../lib/plans/catalog'
import type { PlanLimits } from '../../lib/plans/entitlements'

let saved: { key: string; limits: Record<string, number> }[] | null = null

export async function setLimit(planKey: string, field: keyof PlanLimits, value: number) {
  if (!saved) saved = await admin(db => db.query<{ key: string; limits: Record<string, number> }>('select key, limits from plans'))
  await admin(db => db.query(`update plans set limits = limits || jsonb_build_object($2::text, $3::numeric) where key = $1`, [planKey, field, value]))
  invalidatePlanCache()
}

export async function restoreLimits() {
  if (saved) { const rows = saved; await admin(async db => { for (const r of rows) await db.query('update plans set limits = $2 where key = $1', [r.key, JSON.stringify(r.limits)]) }) }
  invalidatePlanCache()
}
