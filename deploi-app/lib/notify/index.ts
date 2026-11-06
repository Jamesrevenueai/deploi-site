/**
 * Owner and crew updates. SHARED INTERFACE — owned by workstream W2.
 * notifyOwner: a professional HTML email (subject, what happened, what the agent did, proof, link to details/undo),
 * sent through the system mailer (held unless EMAIL_LIVE_SENDS allows), plus text/voice behind the same call.
 * notifyCrew: a message to a crew member (packer, warehouse, field crew) about a job; their "done" reply
 * becomes an AgentEvent { source: 'crew', type: 'crew.done' }.
 */
export type ProofItem = { label: string; value: string; url?: string | null }
export type OwnerUpdate = {
  orgId: string
  agentKey: string
  agentName: string
  caseRef?: string | null
  headline: string
  whatHappened: string
  whatIDid: string[]
  proof: ProofItem[]
  /** an undo the owner can use, when the action can be reversed */
  undoToken?: string | null
  /** app path for the details page, e.g. /store/work/DC-000123 */
  detailsPath: string
  severity?: 'info' | 'action' | 'warning'
  /** one update per dedupeKey */
  dedupeKey: string
}
export type NotifyResult = { status: 'sent' | 'held' | 'queued' | 'skipped' | 'failed'; id: string | null; reason?: string }
export type CrewMessage = {
  orgId: string
  crewMemberId: string
  jobRef: string
  subject: string
  body: string
  address?: string | null
  photos?: string[]
  dedupeKey: string
}

let ownerImpl: (u: OwnerUpdate) => Promise<NotifyResult> = async () => ({ status: 'skipped', id: null, reason: 'owner updates not wired yet' })
let crewImpl: (m: CrewMessage) => Promise<NotifyResult> = async () => ({ status: 'skipped', id: null, reason: 'crew messages not wired yet' })
export const notifyOwner = (u: OwnerUpdate) => ownerImpl(u)
export const notifyCrew = (m: CrewMessage) => crewImpl(m)
/** W2 installs the real implementations */
export function setNotifyImpl(o: { owner?: typeof ownerImpl; crew?: typeof crewImpl }) { if (o.owner) ownerImpl = o.owner; if (o.crew) crewImpl = o.crew }
