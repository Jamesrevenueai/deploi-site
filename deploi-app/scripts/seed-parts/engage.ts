/**
 * Engage seed: one Buckeye engagement (referral_response) in pilot, with its transition history,
 * an onboarding checklist that is mostly complete, and a pilot with baseline measurements.
 * Synthetic data only; deterministic ids so it can run any number of times.
 */
import type { SeedCtx } from './index'
import { uuidFrom } from '../../lib/ids'
import { proposalDefaults } from '../../lib/engagements/defaults'
import { DEFAULT_ITEMS } from '../../lib/onboarding/checklist'

type Row = Record<string, unknown>
async function upsert(c: SeedCtx['c'], table: string, rows: Row[], conflict = 'id') {
  for (const row of rows) {
    const cols = Object.keys(row)
    const updates = cols.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(',')
    await c.query(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) on conflict (${conflict}) do update set ${updates}`, cols.map(k => row[k]))
  }
  return rows.length
}
const daysAgo = (n: number, hour = 10) => { const d = new Date(); d.setUTCHours(hour, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d }
const iso = (d: Date) => d.toISOString()
const ymd = (d: Date) => d.toISOString().slice(0, 10)

export async function seedArea({ c, agencyA, counts }: SeedCtx) {
  const staff = uuidFrom('user:hello')
  const engagementId = uuidFrom('engagement:buckeye:referral_response')
  const f = proposalDefaults('referral_response', 'America/New_York')
  const acceptance = { method: 'email', reference: 'msg-2026-10-02-accept (synthetic)', accepted_by: 'Dana Whitaker (synthetic)', accepted_at: iso(daysAgo(19, 15)), recorded_by: staff }

  counts.engagements = await upsert(c, 'engagements', [{
    id: engagementId, agency_id: agencyA, prospect_id: uuidFrom('prospect:buckeye'), assessment_id: uuidFrom('assessment:buckeye'), service_key: 'referral_response', status: 'pilot',
    setup_fee_cents: 350000, monthly_fee_cents: 75000, credit_applied_cents: 0,
    defined_workflow: f.defined_workflow, included_volume: f.included_volume, volume_units: f.volume_units, usage_terms: f.usage_terms,
    input_method: 'email_inbox', integration_key: 'resend', milestones: JSON.stringify(f.milestones.map((m, i) => ({ ...m, due_on: ymd(daysAgo(14 - i * 3)), done: i < 3 }))),
    acceptance_criteria: JSON.stringify(f.acceptance_criteria), agency_contact: 'Dana Whitaker (synthetic)', deploi_owner: 'Deploi Staff', approval_owner: 'Dana Whitaker (synthetic)',
    support_hours: f.support_hours, support_timezone: 'America/New_York', escalation_contact: 'hello@getdeploi.com', fix_period_days: f.fix_period_days, initial_term_months: f.initial_term_months,
    exclusions: JSON.stringify(f.exclusions), change_request_process: f.change_request_process, acceptance_evidence: JSON.stringify(acceptance), created_by: staff, created_at: iso(daysAgo(24)),
  }])

  const path: [string | null, string, number, string][] = [
    [null, 'draft', 24, 'created'], ['draft', 'proposed', 22, 'proposal sent'], ['proposed', 'accepted', 19, 'accepted by email'],
    ['accepted', 'building', 17, 'build started'], ['building', 'testing', 9, 'live inbox test passed'], ['testing', 'pilot', 5, 'pilot started'],
  ]
  await c.query('delete from engagement_transitions where engagement_id = $1', [engagementId])
  for (const [i, [from, to, ago, note]] of path.entries()) {
    await c.query('insert into engagement_transitions (id, engagement_id, agency_id, from_status, to_status, actor_id, at, note, evidence) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [uuidFrom(`engagement:buckeye:transition:${i}`), engagementId, agencyA, from, to, staff, iso(daysAgo(ago, 11)), note, to === 'accepted' ? JSON.stringify(acceptance) : null])
  }
  counts.engagement_transitions = path.length

  // checklist: everything complete except training; input source tested LIVE (synthetic evidence, not simulated)
  const incomplete = new Set(['training_completed'])
  const items = DEFAULT_ITEMS.map((d, i) => ({
    id: uuidFrom(`onboarding:buckeye:${d.key}`), engagement_id: engagementId, agency_id: agencyA, key: d.key, label: d.label, dimension: d.dimension, required: d.required, sort_order: i,
    completed_at: incomplete.has(d.key) ? null : iso(daysAgo(16 - Math.min(i, 10))), completed_by: incomplete.has(d.key) ? null : staff,
    note: incomplete.has(d.key) ? null : d.key === 'input_source_tested' ? 'Forwarded referral reached the inbox alias (synthetic evidence).' : 'Confirmed with the agency (synthetic).',
    evidence: incomplete.has(d.key) ? null : JSON.stringify(d.key === 'input_source_tested' ? { method: 'forwarded_email', simulated: false, reference: 'inbox-test-2026-10-12 (synthetic)' } : { simulated: false }),
  }))
  counts.onboarding_items = await upsert(c, 'onboarding_items', items)

  const pilotId = uuidFrom('pilot:buckeye:referral_response')
  counts.pilots = await upsert(c, 'pilots', [{
    id: pilotId, engagement_id: engagementId, agency_id: agencyA, starts_on: ymd(daysAgo(5)), ends_on: ymd(daysAgo(-25)), primary_workflow: 'referral_response',
    scope: 'All referrals arriving at the forwarded inbox alias for Franklin, Delaware, Licking and Fairfield counties.', sample_description: 'Every referral received during the pilot window; no exclusions.',
    baseline_start: ymd(daysAgo(35)), baseline_end: ymd(daysAgo(6)), primary_metric_key: 'referral_response_time',
    quality_guardrails: JSON.stringify(['Every proposed reply approved by a person', 'No reply to a referral outside capacity rules', 'Zero messages sent to a contact without consent']),
    data_sources: JSON.stringify(['referrals table (inbox + manual log)', 'proposed_actions (approvals, sends)']), review_owner: 'Deploi Staff',
    decision_date: null, decision: null, decision_note: null, decided_by: null, decided_at: null,
  }])

  const baseline = [
    { key: 'referral_response_time', numerator: 7, denominator: 9, value: 412, sample: 7, note: '2 referrals had no first response and are excluded from the median.' },
    { key: 'followup_completion', numerator: 2, denominator: 6, value: 0.33, sample: 6, note: null },
    { key: 'staff_handling_time', numerator: null, denominator: null, value: null, sample: 0, note: 'Manual entry required; nothing is computed.' },
    { key: 'failed_actions', numerator: 0, denominator: 0, value: null, sample: 0, note: 'No actions were attempted in the period.' },
    { key: 'corrections_required', numerator: 0, denominator: 0, value: null, sample: 0, note: 'No actions were decided in the period.' },
    { key: 'human_review_rate', numerator: 0, denominator: 0, value: null, sample: 0, note: 'No actions were decided in the period.' },
  ]
  counts.pilot_measurements = await upsert(c, 'pilot_measurements', baseline.map(b => ({
    id: uuidFrom(`pilot:buckeye:measurement:baseline:${b.key}`), pilot_id: pilotId, agency_id: agencyA, metric_key: b.key, period: 'baseline',
    period_start: ymd(daysAgo(35)), period_end: ymd(daysAgo(6)), numerator: b.numerator, denominator: b.denominator, value: b.value, sample_size: b.sample,
    missing_data_note: b.note, source: 'computed', computed_at: iso(daysAgo(5, 9)), computed_by: staff,
  })))
}
