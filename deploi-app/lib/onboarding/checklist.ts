/**
 * Default onboarding checklist per engagement. Every item records who completed it and when.
 * `agreements_recorded` is auto-satisfied from agencies.baa_signed_at and is shown as
 * "BAA recorded; not proof of full compliance". Evidence marked simulated never satisfies a live gate.
 */
import type { Db } from '../db'

export const DIMENSIONS = ['configuration', 'data_quality', 'security_controls', 'integration_verification', 'operational_readiness', 'commercial_readiness'] as const
export type Dimension = (typeof DIMENSIONS)[number]

export const DIMENSION_LABEL: Record<Dimension, string> = {
  configuration: 'Configuration',
  data_quality: 'Data quality',
  security_controls: 'Security controls',
  integration_verification: 'Integration verification',
  operational_readiness: 'Operational readiness',
  commercial_readiness: 'Commercial readiness',
}

export type ChecklistItemDef = { key: string; label: string; dimension: Dimension; required: boolean; help: string; auto?: 'baa' }

export const DEFAULT_ITEMS: ChecklistItemDef[] = [
  { key: 'agency_config', label: 'Agency configuration and timezone confirmed', dimension: 'configuration', required: true, help: 'Name, county, timezone and capacity rules reviewed with the agency.' },
  { key: 'service_selected', label: 'Selected service confirmed', dimension: 'configuration', required: true, help: 'The engagement service matches what the proposal sold.' },
  { key: 'staff_responsibilities', label: 'Named staff responsibilities', dimension: 'operational_readiness', required: true, help: 'Agency contact, Deploi owner and action-approval owner are named on the proposal.' },
  { key: 'data_access', label: 'Data access authorization', dimension: 'security_controls', required: true, help: 'The agency authorized the specific exports, inbox or roster access in writing. Never a password in a form.' },
  { key: 'agreements_recorded', label: 'Required agreements recorded', dimension: 'commercial_readiness', required: true, help: 'BAA recorded; not proof of full compliance. Auto-satisfied from the agency BAA date.', auto: 'baa' },
  { key: 'templates_approved', label: 'Communication templates approved', dimension: 'configuration', required: true, help: 'Every message template the worker proposes was approved by the agency.' },
  { key: 'consent_info', label: 'Consent information available', dimension: 'security_controls', required: true, help: 'SMS consent language and per-contact consent records are available where texts are proposed.' },
  { key: 'baseline_captured', label: 'Baseline captured', dimension: 'data_quality', required: true, help: 'Baseline measurements exist for the pilot primary metric (see Pilot).' },
  { key: 'input_source_tested', label: 'Input source tested', dimension: 'integration_verification', required: true, help: 'A real input (not a simulated one) reached the app through the agreed method. A mocked adapter does not count.' },
  { key: 'escalation_path', label: 'Human escalation path established', dimension: 'operational_readiness', required: true, help: 'Escalation contact and support hours are on the proposal and were tested once.' },
  { key: 'training_completed', label: 'Training completed', dimension: 'operational_readiness', required: true, help: 'The approval owner has reviewed, edited and skipped a proposed action in the app.' },
  { key: 'acceptance_tests_passed', label: 'Acceptance tests passed', dimension: 'integration_verification', required: true, help: 'Every acceptance criterion on the proposal was checked with the agency.' },
  { key: 'pilot_approval_recorded', label: 'Pilot approval recorded', dimension: 'commercial_readiness', required: true, help: 'The agency approved the pilot scope, dates and primary metric.' },
]

export type OnboardingItemRow = {
  id: string; engagement_id: string; agency_id: string; key: string; label: string; dimension: Dimension; required: boolean; sort_order: number
  completed_at: string | null; completed_by: string | null; note: string | null; evidence: Record<string, unknown> | null
}

/** Insert the default items an engagement does not have yet. Idempotent. */
export async function ensureChecklist(db: Db, engagementId: string, agencyId: string) {
  for (const [i, d] of DEFAULT_ITEMS.entries()) {
    await db.query(
      `insert into onboarding_items (engagement_id, agency_id, key, label, dimension, required, sort_order) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (engagement_id, key) do nothing`,
      [engagementId, agencyId, d.key, d.label, d.dimension, d.required, i])
  }
}

export async function listChecklist(db: Db, engagementId: string) {
  return db.query<OnboardingItemRow>('select * from onboarding_items where engagement_id = $1 order by sort_order, key', [engagementId])
}

export async function completeItem(db: Db, input: { engagementId: string; key: string; actorId: string | null; note?: string | null; evidence?: Record<string, unknown> | null }) {
  const r = await db.query(
    'update onboarding_items set completed_at = now(), completed_by = $3, note = $4, evidence = $5 where engagement_id = $1 and key = $2 returning id',
    [input.engagementId, input.key, input.actorId, input.note ?? null, input.evidence ? JSON.stringify(input.evidence) : null])
  return r.length
}

export async function uncompleteItem(db: Db, input: { engagementId: string; key: string }) {
  const r = await db.query('update onboarding_items set completed_at = null, completed_by = null, evidence = null where engagement_id = $1 and key = $2 returning id', [input.engagementId, input.key])
  return r.length
}
