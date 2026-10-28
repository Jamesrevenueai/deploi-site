/**
 * Every proposal and execution status maps to exactly one outcome category the merchant sees.
 * Pending: waiting on a person or still running. Verified: changed and confirmed by a fresh read.
 * Failed: the platform refused the change, or the change did not hold. Blocked: not attempted
 * because something made it unsafe or impossible (stale records, expired, missing permission,
 * billing, live writes disabled, loop guard).
 */
export type Outcome = 'pending' | 'verified' | 'failed' | 'blocked' | 'closed'

const PROPOSAL: Record<string, Outcome> = {
  pending_approval: 'pending', approved: 'pending', executing: 'pending', applied: 'pending',
  verified: 'verified',
  failed: 'failed',
  blocked: 'blocked', stale: 'blocked', expired: 'blocked',
  dismissed: 'closed', superseded: 'closed',
}
const EXECUTION: Record<string, Outcome> = {
  prechecking: 'pending', executing: 'pending', applied: 'pending', unknown: 'pending',
  verified: 'verified',
  failed: 'failed', verification_failed: 'failed',
  blocked: 'blocked', stale: 'blocked',
}

export function proposalOutcome(status: string): Outcome { return PROPOSAL[status] ?? 'blocked' }
export function executionOutcome(status: string): Outcome { return EXECUTION[status] ?? 'blocked' }

export const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: 'Pending', verified: 'Verified', failed: 'Failed', blocked: 'Blocked', closed: 'Closed',
}

export const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Waiting for your approval',
  approved: 'Approved, about to run',
  executing: 'Running',
  applied: 'Applied, verifying',
  verified: 'Verified',
  failed: 'Failed',
  blocked: 'Blocked',
  stale: 'Stale: records changed',
  expired: 'Expired',
  dismissed: 'Dismissed',
  superseded: 'Replaced by a newer proposal',
}

export const EXECUTION_STATUS_LABEL: Record<string, string> = {
  prechecking: 'Re-reading records',
  executing: 'Writing the change',
  applied: 'Applied, verifying',
  unknown: 'No definite answer from the platform; verifying',
  verified: 'Verified by a fresh read',
  failed: 'Failed',
  verification_failed: 'Applied but a fresh read does not show the change',
  blocked: 'Blocked before writing',
  stale: 'Not run: records changed since approval',
}
