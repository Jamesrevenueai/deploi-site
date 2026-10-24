/**
 * Engagement lifecycle. The forward path is
 *   draft -> proposed -> accepted -> building -> testing -> pilot -> active (<-> paused) -> completed
 * Back-transitions are listed explicitly below; nothing reaches building or later without
 * passing through accepted, and accepted needs recorded acceptance evidence (transition.ts).
 */
export const STATUSES = ['draft', 'proposed', 'accepted', 'building', 'testing', 'pilot', 'active', 'paused', 'completed'] as const
export type EngagementStatus = (typeof STATUSES)[number]

export const STATUS_LABEL: Record<EngagementStatus, string> = {
  draft: 'Draft', proposed: 'Proposed', accepted: 'Accepted', building: 'Building', testing: 'Testing',
  pilot: 'Pilot', active: 'Active', paused: 'Paused', completed: 'Completed',
}

/** Legal transitions. Forward steps plus the explicit back-steps a staff member may take. */
export const TRANSITIONS: Record<EngagementStatus, readonly EngagementStatus[]> = {
  draft: ['proposed'],
  proposed: ['accepted', 'draft'],
  accepted: ['building', 'proposed'],
  building: ['testing', 'accepted'],
  testing: ['pilot', 'building'],
  pilot: ['active', 'testing', 'paused', 'completed'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: [],
}

/** Statuses that a row can only hold after acceptance was recorded. */
export const POST_ACCEPTANCE: readonly EngagementStatus[] = ['accepted', 'building', 'testing', 'pilot', 'active', 'paused', 'completed']

export const isStatus = (s: string): s is EngagementStatus => (STATUSES as readonly string[]).includes(s)
export function canTransition(from: EngagementStatus, to: EngagementStatus) { return TRANSITIONS[from].includes(to) }
export function nextStatuses(from: EngagementStatus): readonly EngagementStatus[] { return TRANSITIONS[from] }

/** The transitions that need a launch gate (lib/onboarding/readiness.ts) before they are allowed. */
export const GATED: readonly EngagementStatus[] = ['building', 'testing', 'pilot', 'active']

export const ACCEPTANCE_METHODS = ['email', 'signed_pdf', 'verbal_confirmed', 'portal'] as const
export type AcceptanceMethod = (typeof ACCEPTANCE_METHODS)[number]
export type AcceptanceEvidence = {
  method: AcceptanceMethod
  /** message id, file name, portal reference, or who confirmed verbally and when */
  reference: string
  accepted_by: string
  accepted_at: string
  recorded_by: string | null
}

export function isAcceptanceEvidence(v: unknown): v is AcceptanceEvidence {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (ACCEPTANCE_METHODS as readonly string[]).includes(String(e.method))
    && typeof e.accepted_by === 'string' && e.accepted_by.trim().length > 0
    && typeof e.accepted_at === 'string' && !Number.isNaN(Date.parse(e.accepted_at))
    && typeof e.reference === 'string'
}

export const STATUS_TONE: Record<EngagementStatus, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = {
  draft: 'muted', proposed: 'warn', accepted: 'none', building: 'none', testing: 'none', pilot: 'warn', active: 'ok', paused: 'danger', completed: 'muted',
}
