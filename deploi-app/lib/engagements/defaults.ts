/**
 * Draft proposal prefilled from the catalog service and the commercial defaults.
 * Fees start at the minimum of the published ranges and are a DRAFT: exact scope sets the quote.
 */
import { getService, type ServiceDef } from '../catalog/services'
import { getPricing } from '../catalog/pricing'
import { INTEGRATIONS } from '../catalog/integrations'
import type { ProposalFields } from './types'

export class EngagementServiceError extends Error {
  constructor(public code: 'unknown_service' | 'standalone_service', msg: string) { super(msg); this.name = 'EngagementServiceError' }
}

/** Only non-standalone services become engagements; Website Improvement lives in website_engagements. */
export function engagementService(serviceKey: string): ServiceDef {
  const svc = getService(serviceKey)
  if (!svc) throw new EngagementServiceError('unknown_service', `unknown service ${serviceKey}`)
  if (svc.standalone) throw new EngagementServiceError('standalone_service', `${svc.name} is standalone and is not an engagement`)
  return svc
}

/** "Up to 60 referrals per month ..." -> { volume: 60, units: 'referrals per month' } */
export function parseVolume(limit: string | undefined): { volume: number | null; units: string | null } {
  if (!limit) return { volume: null, units: null }
  const m = /up to\s+([\d,]+)\s+([a-z -]+?)(?:\s+(?:in|per agency)\b|$)/i.exec(limit)
  if (!m) return { volume: null, units: null }
  return { volume: Number(m[1].replace(/,/g, '')), units: m[2].trim() }
}

export const INPUT_METHOD_LABEL: Record<string, string> = {
  csv: 'CSV export', manual_entry: 'Manual entry', email_inbox: 'Email inbox', webhook: 'Webhook', sms_reply: 'SMS reply', staff_delivered: 'Staff delivered',
}

/** Integrations that can carry the chosen input method. */
export function integrationsForInput(inputMethod: string | null) {
  if (inputMethod === 'email_inbox') return INTEGRATIONS.filter(i => i.kind === 'email')
  if (inputMethod === 'sms_reply') return INTEGRATIONS.filter(i => i.kind === 'sms')
  if (inputMethod === 'csv') return INTEGRATIONS.filter(i => i.kind === 'evv')
  return []
}

export const DEFAULT_CHANGE_REQUEST_PROCESS =
  'Either side writes the requested change down (what, why, by when). Deploi answers within five business days with the effect on scope, fee and dates. Nothing changes until both sides confirm in writing. New workers, integrations or reports are always a separate quote.'

export function proposalDefaults(serviceKey: string, agencyTimezone = 'America/New_York'): ProposalFields {
  const svc = engagementService(serviceKey)
  const p = getPricing()
  const vol = parseVolume(svc.volumeLimits[0])
  return {
    setup_fee_cents: Math.round(p.build.min * 100),
    monthly_fee_cents: Math.round(p.management.min * 100),
    defined_workflow: [svc.description, '', 'Ongoing: ' + svc.ongoingDeliverables.join('; ') + '.', 'Human review: ' + svc.humanReview.join(' ')].join('\n'),
    included_volume: vol.volume,
    volume_units: vol.units,
    usage_terms: svc.volumeLimits.join(' ') + ' Volume above the included amount is quoted before it is billed; nothing is auto-charged.',
    input_method: svc.inputMethods[0] ?? null,
    integration_key: null,
    milestones: svc.setupDeliverables.map(title => ({ title, due_on: null, done: false })),
    acceptance_criteria: [
      ...svc.setupDeliverables.map(d => `${d} (confirmed by the agency contact)`),
      ...svc.successMeasures.map(m => `${m.label} is measured as: ${m.definition}`),
    ],
    agency_contact: null,
    deploi_owner: null,
    approval_owner: null,
    support_hours: 'Monday to Friday, 9:00 to 17:00',
    support_timezone: agencyTimezone,
    escalation_contact: null,
    fix_period_days: p.build.fixPeriodDays,
    initial_term_months: p.management.initialTermMonths,
    exclusions: [...svc.exclusions],
    change_request_process: DEFAULT_CHANGE_REQUEST_PROCESS,
  }
}
