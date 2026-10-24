/**
 * Server-side transition enforcement. Every status change goes through here: the transition
 * table and the gate are checked against the row as stored (never against the form), the
 * timestamp for the new state is set, and a website_transitions row is written.
 */
import type { Db } from '../db'
import { gateFor, isStatus, type Engagement, type Status } from './states'
import { refreshTargetDate, getEngagementRaw } from './queries'

export class TransitionError extends Error {
  constructor(public code: 'not_found' | 'invalid_status' | 'blocked', msg: string) { super(msg); this.name = 'TransitionError' }
}

const STAMP: Partial<Record<Status, string>> = {
  scope_confirmed: 'scope_confirmed_at', accepted: 'accepted_at', access_received: 'access_received_at',
  preview_ready: 'preview_ready_at', published: 'published_at',
}

export async function transitionEngagement(db: Db, id: string, to: string, actorId: string | null, note: string | null = null): Promise<Engagement> {
  if (!isStatus(to)) throw new TransitionError('invalid_status', 'unknown status')
  const e = await getEngagementRaw(db, id)
  if (!e) throw new TransitionError('not_found', 'engagement not found')
  const gate = gateFor(e, to)
  if (!gate.ok) throw new TransitionError('blocked', gate.reason)

  const sets: string[] = ['status = $2']
  const params: unknown[] = [id, to]
  const stamp = STAMP[to]
  if (stamp) sets.push(`${stamp} = coalesce(${stamp}, now())`)
  if (to === 'customer_approved') {
    // the approval timestamp is the evidence's "at" when given, otherwise now
    sets.push(`customer_approved_at = coalesce((customer_approval_evidence ->> 'at')::timestamptz, customer_approved_at, now())`)
  }
  if (to === 'improving' && e.status === 'preview_ready') {
    sets.push('revision_round = revision_round + 1', `revision_status = 'in revision'`, 'preview_ready_at = null')
  }
  if (to === 'completed') sets.push('publication_verified_at = coalesce(publication_verified_at, now())')
  await db.query(`update website_engagements set ${sets.join(', ')} where id = $1`, params)
  await db.query('insert into website_transitions (website_engagement_id, from_status, to_status, actor_id, note) values ($1,$2,$3,$4,$5)',
    [id, e.status, to, actorId, note])
  if (to === 'access_received') await refreshTargetDate(db, id)
  return (await getEngagementRaw(db, id))!
}
