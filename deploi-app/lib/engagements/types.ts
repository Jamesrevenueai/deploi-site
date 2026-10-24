import type { EngagementStatus, AcceptanceEvidence } from './states'

export type Milestone = { title: string; due_on?: string | null; done?: boolean }

export type EngagementRow = {
  id: string
  agency_id: string
  prospect_id: string | null
  assessment_id: string | null
  service_key: string
  status: EngagementStatus
  setup_fee_cents: number
  monthly_fee_cents: number
  credit_applied_cents: number
  defined_workflow: string | null
  included_volume: number | null
  volume_units: string | null
  usage_terms: string | null
  input_method: string | null
  integration_key: string | null
  milestones: Milestone[]
  acceptance_criteria: string[]
  agency_contact: string | null
  deploi_owner: string | null
  approval_owner: string | null
  support_hours: string | null
  support_timezone: string | null
  escalation_contact: string | null
  fix_period_days: number | null
  initial_term_months: number | null
  exclusions: string[]
  change_request_process: string | null
  acceptance_evidence: AcceptanceEvidence | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type EngagementView = EngagementRow & { agency_name: string; agency_timezone: string; baa_signed_at: string | null; owner_name: string | null }

export type TransitionRow = {
  id: string; engagement_id: string; from_status: string | null; to_status: string; actor_id: string | null; at: string; note: string | null; evidence: Record<string, unknown> | null
}

/** Editable proposal fields (everything except ids, status, credit and acceptance). */
export type ProposalFields = Pick<EngagementRow,
  'setup_fee_cents' | 'monthly_fee_cents' | 'defined_workflow' | 'included_volume' | 'volume_units' | 'usage_terms' | 'input_method' | 'integration_key' |
  'milestones' | 'acceptance_criteria' | 'agency_contact' | 'deploi_owner' | 'approval_owner' | 'support_hours' | 'support_timezone' | 'escalation_contact' |
  'fix_period_days' | 'initial_term_months' | 'exclusions' | 'change_request_process'>
