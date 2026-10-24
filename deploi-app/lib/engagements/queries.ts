import type { Db } from '../db'
import type { EngagementRow, EngagementView, ProposalFields, TransitionRow } from './types'
import { proposalDefaults } from './defaults'

export const ENGAGEMENT_SELECT = `
  select e.*, g.name as agency_name, g.timezone as agency_timezone, g.baa_signed_at, p.owner_name
  from engagements e
  join agencies g on g.id = e.agency_id
  left join prospects p on p.id = e.prospect_id`

export async function listEngagements(db: Db, opts: { status?: string | null; agencyId?: string | null } = {}) {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status) { params.push(opts.status); where.push(`e.status = $${params.length}`) }
  if (opts.agencyId) { params.push(opts.agencyId); where.push(`e.agency_id = $${params.length}`) }
  return db.query<EngagementView>(`${ENGAGEMENT_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by e.updated_at desc limit 200`, params)
}

export async function getEngagement(db: Db, id: string) {
  const row = await db.one<EngagementView>(`${ENGAGEMENT_SELECT} where e.id = $1`, [id])
  if (row) await db.auditRead('engagements', row.agency_id, [row.id])
  return row
}

export async function listTransitions(db: Db, engagementId: string) {
  return db.query<TransitionRow>('select * from engagement_transitions where engagement_id = $1 order by at desc, id', [engagementId])
}

export async function createEngagement(db: Db, input: { agencyId: string; prospectId?: string | null; assessmentId?: string | null; serviceKey: string; createdBy: string | null; overrides?: Partial<ProposalFields> }) {
  const tz = (await db.one<{ timezone: string }>('select timezone from agencies where id = $1', [input.agencyId]))?.timezone ?? 'America/New_York'
  const f: ProposalFields = { ...proposalDefaults(input.serviceKey, tz), ...(input.overrides ?? {}) }
  const r = await db.one<{ id: string }>(
    `insert into engagements (agency_id, prospect_id, assessment_id, service_key, status, setup_fee_cents, monthly_fee_cents, defined_workflow, included_volume, volume_units, usage_terms,
       input_method, integration_key, milestones, acceptance_criteria, agency_contact, deploi_owner, approval_owner, support_hours, support_timezone, escalation_contact,
       fix_period_days, initial_term_months, exclusions, change_request_process, created_by)
     values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) returning id`,
    [input.agencyId, input.prospectId ?? null, input.assessmentId ?? null, input.serviceKey, f.setup_fee_cents, f.monthly_fee_cents, f.defined_workflow, f.included_volume, f.volume_units, f.usage_terms,
     f.input_method, f.integration_key, JSON.stringify(f.milestones), JSON.stringify(f.acceptance_criteria), f.agency_contact, f.deploi_owner, f.approval_owner, f.support_hours, f.support_timezone, f.escalation_contact,
     f.fix_period_days, f.initial_term_months, JSON.stringify(f.exclusions), f.change_request_process, input.createdBy])
  await db.query('insert into engagement_transitions (engagement_id, agency_id, from_status, to_status, actor_id, note) values ($1,$2,null,$3,$4,$5)', [r!.id, input.agencyId, 'draft', input.createdBy, 'created'])
  return r!.id
}

/** Proposal fields are editable until the engagement is accepted; after that only owners/contacts/support may change. */
export const EDITABLE_AFTER_ACCEPTANCE: (keyof ProposalFields)[] = ['agency_contact', 'deploi_owner', 'approval_owner', 'support_hours', 'support_timezone', 'escalation_contact']

export async function updateProposal(db: Db, id: string, fields: Partial<ProposalFields>) {
  const row = await db.one<EngagementRow>('select * from engagements where id = $1 for update', [id])
  if (!row) throw new Error('engagement not found')
  const locked = row.status !== 'draft' && row.status !== 'proposed'
  const sets: string[] = []
  const params: unknown[] = [id]
  for (const [k, v] of Object.entries(fields) as [keyof ProposalFields, unknown][]) {
    if (locked && !EDITABLE_AFTER_ACCEPTANCE.includes(k)) continue
    params.push(Array.isArray(v) ? JSON.stringify(v) : v)
    sets.push(`${k} = $${params.length}`)
  }
  if (!sets.length) return { updated: 0, locked }
  await db.query(`update engagements set ${sets.join(', ')} where id = $1`, params)
  return { updated: sets.length, locked }
}

/** Mirror credit_applied_cents from the ledger (sum of live applications for this engagement). */
export async function syncCreditApplied(db: Db, engagementId: string) {
  const r = await db.one<{ total: string }>('select coalesce(sum(amount_cents), 0)::text as total from assessment_credit_applications where engagement_ref = $1 and reversed_at is null', [engagementId])
  const total = Number(r?.total ?? 0)
  await db.query('update engagements set credit_applied_cents = $2 where id = $1', [engagementId, total])
  return total
}
