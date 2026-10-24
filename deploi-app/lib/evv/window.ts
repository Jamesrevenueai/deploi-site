/**
 * Correction-window deadlines come only from a matching evv_rule_sets row. When no rule matches the
 * (agency, state, program, payer, visit date) the deadline is null and the UI says "deadline not configured".
 * There is no fallback number anywhere: an unknown window stays unknown.
 */
import type { Db } from '../db'

const DAY = 86_400_000

export type UnitRounding = 'nearest' | 'down' | 'up'

export type RuleSet = {
  id: string
  agency_id: string | null
  program: string | null
  payer: string | null
  jurisdiction: string
  effective_from: string | null   // YYYY-MM-DD
  effective_to: string | null
  correction_window_days: number | null
  unit_minutes: number
  unit_rounding: UnitRounding
  duration_tolerance_min: number
  source_name: string | null
  source_url: string | null
  source_version: string | null
  verified: boolean
  notes: string | null
}

export type RuleQuery = { agencyId: string; state: string | null | undefined; program: string | null | undefined; payer?: string | null; date: Date | null | undefined }

export const DEADLINE_NOT_CONFIGURED = 'deadline not configured'

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const eqi = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * Pure resolver. A rule matches when its jurisdiction equals the agency state, its agency is null or the
 * agency, its program is null or equals the visit's program, its payer is null or equals the payer, and the
 * visit date is inside [effective_from, effective_to]. The most specific match wins
 * (agency-specific > global, program match > any, payer match > any, latest effective_from).
 */
export function pickRuleSet(rules: RuleSet[], q: RuleQuery): RuleSet | null {
  if (!q.state) return null
  const date = q.date ? ymd(q.date) : null
  const candidates = rules.filter(r => {
    if (!eqi(r.jurisdiction, q.state)) return false
    if (r.agency_id && r.agency_id !== q.agencyId) return false
    if (r.program && !eqi(r.program, q.program)) return false
    if (r.payer && !eqi(r.payer, q.payer)) return false
    if (date) {
      if (r.effective_from && r.effective_from > date) return false
      if (r.effective_to && r.effective_to < date) return false
    } else if (r.effective_from || r.effective_to) return false
    return true
  })
  if (!candidates.length) return null
  const score = (r: RuleSet) => (r.agency_id ? 4 : 0) + (r.program ? 2 : 0) + (r.payer ? 1 : 0)
  return candidates.sort((a, b) => score(b) - score(a) || (b.effective_from ?? '').localeCompare(a.effective_from ?? ''))[0]
}

/** Every rule that could apply to an agency (its own and the global ones for its state). */
export async function loadRuleSets(db: Db, agencyId: string, state: string | null | undefined): Promise<RuleSet[]> {
  if (!state) return []
  const rows = await db.query<RuleSet & { effective_from: Date | string | null; effective_to: Date | string | null }>(
    `select id, agency_id, program, payer, jurisdiction, effective_from::text, effective_to::text, correction_window_days, unit_minutes, unit_rounding, duration_tolerance_min,
            source_name, source_url, source_version, verified, notes
     from evv_rule_sets where upper(jurisdiction) = upper($2) and (agency_id is null or agency_id = $1) order by effective_from nulls first`, [agencyId, state])
  return rows.map(r => ({ ...r, effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : null, effective_to: r.effective_to ? String(r.effective_to).slice(0, 10) : null }))
}

export async function resolveRuleSet(db: Db, q: RuleQuery): Promise<RuleSet | null> {
  return pickRuleSet(await loadRuleSets(db, q.agencyId, q.state), q)
}

/** Deadline for a visit under a rule set; null when there is no rule or the rule has no window. */
export function windowCloses(visitDate: Date, rule: RuleSet | null | undefined): Date | null {
  if (!rule || rule.correction_window_days == null) return null
  return new Date(visitDate.getTime() + rule.correction_window_days * DAY)
}

export function daysLeft(closesAt: Date, now: Date = new Date()): number {
  return Math.ceil((closesAt.getTime() - now.getTime()) / DAY)
}

export type WindowTone = 'danger' | 'warn' | 'none' | 'muted'
export function windowTone(days: number | null): WindowTone {
  if (days == null) return 'muted'
  if (days <= 7) return 'danger'
  if (days <= 21) return 'warn'
  return 'none'
}

export function windowLabel(days: number | null): string {
  if (days == null) return DEADLINE_NOT_CONFIGURED
  if (days < 0) return `closed ${-days}d ago`
  if (days === 0) return 'closes today'
  return `${days}d left`
}

/** "Working assumption, confirm with ODM · v2026-10 (unverified)" style attribution for exports and pages. */
export function ruleSourceLabel(rule: Pick<RuleSet, 'source_name' | 'source_version' | 'verified'> | null | undefined): string {
  if (!rule) return DEADLINE_NOT_CONFIGURED
  const parts = [rule.source_name ?? 'unnamed source', rule.source_version ? `v${rule.source_version}` : null, rule.verified ? 'verified' : 'unverified'].filter(Boolean)
  return parts.join(' · ')
}
