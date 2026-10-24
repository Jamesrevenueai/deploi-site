/**
 * Readiness per dimension and the launch gates, computed from the checklist and live facts.
 * Pure: the page and the transition engine both call computeReadiness with gathered facts.
 *
 * Live rules:
 *  - an item whose evidence is marked simulated (or mocked) never counts
 *  - integration_verification counts only live, non-mocked evidence; the presence of an API key is never enough
 *  - agreements_recorded is satisfied by agencies.baa_signed_at (shown as "BAA recorded; not proof of full compliance")
 */
import { DIMENSIONS, DIMENSION_LABEL, type Dimension, type OnboardingItemRow } from './checklist'
import type { EngagementStatus } from '../engagements/states'

export type PilotFacts = { hasDates: boolean; hasPrimaryMetric: boolean; decision: string | null; baselineMeasurements: number } | null

export type ReadinessFacts = {
  baaSignedAt: string | null
  pilot: PilotFacts
  /** Reported only; never used to satisfy a check. Kept in the type so a test can prove it is ignored. */
  providerKeysPresent?: { email?: boolean; sms?: boolean }
}

export type ItemState = { key: string; label: string; dimension: Dimension; required: boolean; completed: boolean; satisfied: boolean; reason: string | null; completed_at: string | null; completed_by: string | null; note: string | null; evidence: Record<string, unknown> | null }
export type DimensionState = { dimension: Dimension; label: string; required: number; satisfied: number; ready: boolean; missing: string[] }
export type Readiness = { items: ItemState[]; dimensions: DimensionState[]; ready: boolean; missing: string[] }

const isSimulated = (ev: Record<string, unknown> | null | undefined) => Boolean(ev && (ev.simulated === true || ev.mocked === true))

export function itemState(row: OnboardingItemRow, facts: ReadinessFacts): ItemState {
  const completed = Boolean(row.completed_at)
  let satisfied = completed
  let reason: string | null = null
  if (row.key === 'agreements_recorded') {
    satisfied = Boolean(facts.baaSignedAt) || completed
    reason = facts.baaSignedAt ? 'BAA recorded; not proof of full compliance' : completed ? null : 'No signed BAA on the agency'
  }
  if (completed && isSimulated(row.evidence)) {
    satisfied = false
    reason = row.dimension === 'integration_verification' ? 'Simulated or mocked evidence does not verify an integration' : 'Simulated evidence does not count'
  }
  if (row.key === 'baseline_captured' && completed && facts.pilot && facts.pilot.baselineMeasurements === 0) {
    satisfied = false
    reason = 'Marked complete but no baseline measurements exist on the pilot'
  }
  return { key: row.key, label: row.label, dimension: row.dimension, required: row.required, completed, satisfied, reason, completed_at: row.completed_at, completed_by: row.completed_by, note: row.note, evidence: row.evidence }
}

export function computeReadiness(rows: OnboardingItemRow[], facts: ReadinessFacts): Readiness {
  const items = rows.map(r => itemState(r, facts))
  const dimensions: DimensionState[] = DIMENSIONS.map(d => {
    const req = items.filter(i => i.dimension === d && i.required)
    const sat = req.filter(i => i.satisfied)
    return { dimension: d, label: DIMENSION_LABEL[d], required: req.length, satisfied: sat.length, ready: req.length === sat.length, missing: req.filter(i => !i.satisfied).map(i => i.label) }
  })
  const missing = items.filter(i => i.required && !i.satisfied).map(i => i.label)
  return { items, dimensions, ready: missing.length === 0, missing }
}

/** Launch gates per target status. Returns the list of unmet conditions (empty = allowed). */
export function gateFor(to: EngagementStatus, readiness: Readiness, facts: ReadinessFacts): string[] {
  const sat = (key: string) => readiness.items.find(i => i.key === key)?.satisfied ?? false
  const label = (key: string) => readiness.items.find(i => i.key === key)?.label ?? key
  const unmet: string[] = []
  switch (to) {
    case 'building':
      if (!sat('agreements_recorded')) unmet.push(label('agreements_recorded'))
      if (!sat('data_access')) unmet.push(label('data_access'))
      return unmet
    case 'testing':
      if (!sat('input_source_tested')) unmet.push(label('input_source_tested') + ' (live, not simulated)')
      return unmet
    case 'pilot':
      unmet.push(...readiness.missing)
      if (!facts.pilot) unmet.push('A pilot with dates and a primary metric')
      else {
        if (!facts.pilot.hasDates) unmet.push('Pilot start and end dates')
        if (!facts.pilot.hasPrimaryMetric) unmet.push('Pilot primary metric')
      }
      return Array.from(new Set(unmet))
    case 'active':
      if (!facts.pilot) unmet.push('A pilot decision of Continue or Expand')
      else if (facts.pilot.decision !== 'continue' && facts.pilot.decision !== 'expand') unmet.push(`A pilot decision of Continue or Expand (currently ${facts.pilot.decision ?? 'none'})`)
      return unmet
    default:
      return []
  }
}
