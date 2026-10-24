/**
 * Ops seed part: one EVV rule set for Ohio PASSPORT on the demo agency (Buckeye), explicitly unverified
 * ("Working assumption, confirm with ODM"), so the demo keeps deadlines. The control agency (Scioto Valley)
 * gets no rule on purpose: its exceptions show "deadline not configured".
 */
import { uuidFrom } from '../../lib/ids'
import type { SeedCtx } from './index'

export async function seedArea({ c, agencyA, counts }: SeedCtx) {
  await c.query(
    `insert into evv_rule_sets (id, agency_id, program, payer, jurisdiction, effective_from, effective_to, correction_window_days, unit_minutes, unit_rounding, duration_tolerance_min,
                                source_name, source_url, source_version, verified, notes, created_by)
     values ($1, $2, 'PASSPORT', null, 'OH', '2026-01-01', null, 60, 15, 'nearest', 15,
             'Working assumption, confirm with ODM', null, '2026-01', false,
             'Demo rule set. Confirm the correction window and unit rounding with the Ohio Department of Medicaid / ODA PASSPORT program before relying on any deadline.', null)
     on conflict (id) do update set agency_id = excluded.agency_id, program = excluded.program, jurisdiction = excluded.jurisdiction, effective_from = excluded.effective_from,
       correction_window_days = excluded.correction_window_days, unit_minutes = excluded.unit_minutes, unit_rounding = excluded.unit_rounding,
       duration_tolerance_min = excluded.duration_tolerance_min, source_name = excluded.source_name, source_version = excluded.source_version, verified = false, notes = excluded.notes`,
    [uuidFrom('evv_rule_set:oh:passport:buckeye'), agencyA])
  // attribute the seeded Buckeye exceptions' deadlines to the rule set so the UI can show the source
  await c.query('update evv_exceptions set rule_set_id = $1 where agency_id = $2 and rule_set_id is null and window_closes_at is not null', [uuidFrom('evv_rule_set:oh:passport:buckeye'), agencyA])
  counts.evv_rule_sets = 1
}
