/**
 * The only way an engagement changes status. Enforces the transition table, the acceptance-evidence
 * requirement and the launch gates server-side, and writes an engagement_transitions row every time.
 */
import type { Db } from '../db'
import { canTransition, isAcceptanceEvidence, isStatus, nextStatuses, GATED, type EngagementStatus, type AcceptanceEvidence } from './states'
import { gateFor } from '../onboarding/readiness'
import { engagementReadiness } from '../onboarding/facts'
import type { EngagementRow } from './types'
import { log } from '../log'

export class TransitionError extends Error {
  constructor(public code: 'not_found' | 'invalid_status' | 'illegal_transition' | 'acceptance_evidence_required' | 'gate_failed', msg: string, public unmet: string[] = []) {
    super(msg); this.name = 'TransitionError'
  }
}

export type TransitionInput = {
  engagementId: string
  to: string
  actorId: string | null
  note?: string | null
  /** required when `to` is 'accepted' */
  acceptance?: Omit<AcceptanceEvidence, 'recorded_by'> | null
}

export async function transitionEngagement(db: Db, input: TransitionInput) {
  if (!isStatus(input.to)) throw new TransitionError('invalid_status', `unknown status ${input.to}`)
  const to: EngagementStatus = input.to
  const e = await db.one<EngagementRow>('select * from engagements where id = $1 for update', [input.engagementId])
  if (!e) throw new TransitionError('not_found', 'engagement not found')
  if (!canTransition(e.status, to)) throw new TransitionError('illegal_transition', `cannot move from ${e.status} to ${to}`)

  let evidence: Record<string, unknown> | null = null
  if (to === 'accepted') {
    // an internal status change alone is not acceptance: the evidence must be supplied with this transition
    const candidate = input.acceptance ? { ...input.acceptance, recorded_by: input.actorId } : null
    if (!candidate || !isAcceptanceEvidence(candidate)) throw new TransitionError('acceptance_evidence_required', 'record how the customer accepted (method, reference, who, when) before marking accepted')
    evidence = candidate
    await db.query('update engagements set acceptance_evidence = $2 where id = $1', [e.id, JSON.stringify(candidate)])
  }

  if (GATED.includes(to)) {
    const { readiness, facts } = await engagementReadiness(db, e.id, e.agency_id)
    const unmet = gateFor(to, readiness, facts)
    if (unmet.length) throw new TransitionError('gate_failed', `not ready for ${to}: ${unmet.join('; ')}`, unmet)
    evidence = { gate: to, dimensions: readiness.dimensions.map(d => ({ dimension: d.dimension, satisfied: d.satisfied, required: d.required })), pilot: facts.pilot }
  }

  await db.query('update engagements set status = $2 where id = $1', [e.id, to])
  await db.query('insert into engagement_transitions (engagement_id, agency_id, from_status, to_status, actor_id, note, evidence) values ($1,$2,$3,$4,$5,$6,$7)',
    [e.id, e.agency_id, e.status, to, input.actorId, input.note ?? null, evidence ? JSON.stringify(evidence) : null])
  log.info('engagement.transition', { engagement_id: e.id, from: e.status, to })
  return { from: e.status, to }
}

/** Which of the legal next statuses are currently allowed, with the unmet conditions for the rest. */
export async function availableTransitions(db: Db, e: Pick<EngagementRow, 'id' | 'agency_id' | 'status'>) {
  const { readiness, facts } = await engagementReadiness(db, e.id, e.agency_id)
  return nextStatuses(e.status).map(to => ({ to, unmet: GATED.includes(to) ? gateFor(to, readiness, facts) : [] }))
}
