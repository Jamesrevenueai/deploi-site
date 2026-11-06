/**
 * THE CONTRACT between the redesigned logged-in app and its data. The UI imports its types from here (client
 * components: `import type { ... } from '@/lib/app/contract'`; the functions are server-only and read the
 * database) and calls the endpoints below. Everything is real data: a feed with nothing in it is an empty array.
 *
 * Endpoints (all resolve the organization from the session, or a Shopify session token, never from the request;
 * POST/PATCH/DELETE pass the CSRF origin check and the per-organization write limit of resolveActor; staff are
 * refused: they use the staff console):
 *   GET    /api/app/workspace                         -> { ok, workspace, default, canSwitch }
 *   POST   /api/app/workspace                         { workspace: 'store'|'office' } -> { ok, workspace }
 *   GET    /api/app/command-center?workspace=         -> { ok, ...CommandCenter }
 *   POST   /api/app/needs-you/:id                     { decision: 'approve'|'decline', amount? } -> { ok, result: NeedsYouDecision }
 *   GET    /api/app/agents/:id                        -> { ok, dashboard: AgentDashboard }
 *   POST   /api/app/agents/:id/autonomy               { autonomy } -> { ok, ...AutonomyResult }   (owners and admins)
 *   GET    /api/app/agents/:id/instructions           -> { ok, instructions: Instruction[] }
 *   POST   /api/app/agents/:id/instructions           { text, position? } -> { ok, instruction }  (owners and admins)
 *   PATCH  /api/app/agents/:id/instructions/:instructionId  { text?, position? } -> { ok, instruction }
 *   DELETE /api/app/agents/:id/instructions/:instructionId  -> { ok, deleted: true }
 *   GET    /api/app/agents/:id/chat                   -> { ok, messages: ChatMessage[] }   (history, oldest first)
 *   POST   /api/app/agents/:id/chat                   { text } -> { ok, messages: ChatMessage[] }  (this exchange)
 *   GET    /api/app/chat  / POST /api/app/chat        the same for the whole team (team chat)
 * An agent id in a path is a TeamAgent id, URL-encoded (`store%3Ainventory_watcher`).
 *
 * Behaviour that the UI can rely on:
 *  - autonomy actually governs the agent (lib/app/control.ts setAgentAutonomy): loop agents (store and pack) through
 *    lib/events/loop.ts effectiveMode; Office agents through a re-grant of their tool tiers (send_approved |
 *    send_autonomous, granted by the owner); library agents through their permission level and auto-run grants;
 *    engine store agents through their approvalMode (review | autonomous), granted by the owner.
 *  - MONEY GUARD: an action that moves money (lib/autonomy MONEY_ACTIONS) always waits for the owner's approval,
 *    whatever the agent's level or the organization's modes; it shows up in needsYou.
 *  - Chat is rules-only while AI is off: a small set of intents answered from real data; anything else gets an
 *    honest "I can't answer that without AI turned on" with the list of what it can do.
 */
import type { AgentAutonomy, AgentColor } from './profiles'
export { PALETTE, AUTONOMY_LEVELS, INSTRUCTION_MAX, type AgentAutonomy, type AgentColor } from './profiles'

export type Workspace = 'store' | 'office'
export type AgentKind = 'store' | 'office' | 'pack'
export type AgentStatus = 'working' | 'waiting' | 'watching' | 'off'

/** One agent of the team, whatever its kind. */
export type TeamAgent = {
  /** stable: store:<library key> | store:<engine agent uuid> | office:<office agent uuid> | pack:<pack agent key> */
  id: string
  kind: AgentKind
  name: string
  /** what it looks after, one or two words ("Inventory", "Invoices", "Home services") */
  area: string
  /** hex from PALETTE, kept per agent */
  color: AgentColor | string
  status: AgentStatus
  /** one plain line: "Waiting for you: ...", "Working on: ...", "Watching inventory", "Off: switched off" */
  doingNow: string
  /** actions carried out today (UTC) */
  todayActions: number
  /** the owner's level when chosen (autonomyChosen), otherwise what the agent's current grants and modes amount to */
  autonomy: AgentAutonomy
  autonomyChosen: boolean
  workspace: Workspace
  /** its job in one line */
  job: string
}

export type ActionLabel = string
/** Something an agent needs the owner for: an item of the existing approvals queue (agent loops included). */
export type NeedsYouItem = {
  /** `${source}:${item id}`: POST /api/app/needs-you/:id decides it through the existing approval logic */
  id: string
  source: string
  itemId: string
  agent: { id: string | null; name: string; color: string | null }
  createdAt: string
  /** "5 min ago" at the time of the request */
  ago: string
  title: string
  /** what it spotted */
  spotted: string
  /** what it already prepared or started (nothing is done until you decide) */
  prepared: string
  /** spotted + prepared, as one plain explanation */
  explanation: string
  money: boolean
  primaryAction: ActionLabel
  secondaryAction: ActionLabel | null
  /** decisions the item offers (a drafts-only agent's change can only be declined) */
  decisions: ('approve' | 'decline')[]
  caseRef: string | null
  workspace: Workspace
}
export type NeedsYouDecision = { id: string; decision: 'approve' | 'decline'; status: string; source: string; itemId: string }

export type Proof = { label: string; href: string }
export type DoneItem = {
  id: string
  agent: { id: string | null; name: string; color: string | null }
  /** what it did */
  what: string
  at: string
  ago: string
  proof: Proof
  /** true when nobody had to approve it */
  onItsOwn: boolean
  workspace: Workspace
}

export type Hero = {
  agentsRunning: number
  /** the last time any of this side's agents checked (event or scheduled check), or null */
  lastCheckAt: string | null
  /** completed in the last 24 hours */
  handledSinceYesterday: number
  needYouCount: number
  /** estimate, the morning report's formula (lib/notify/morning.ts estimate) over the last 7 days */
  timeSavedWeekMinutes: number
  timeSavedFormula: string
  /** completed in the last 24 hours without anyone approving */
  fixedOnTheirOwn: number
}

export type Allowance = {
  used: number
  /** null while billing is off (the free beta enforces no limit) */
  limit: number | null
  planName: string
  /** ISO: 00:00 UTC on the first day of next month */
  resetsAt: string
  enforced: boolean
}

export type CommandCenter = { workspace: Workspace; hero: Hero; needsYou: NeedsYouItem[]; doneWithProof: DoneItem[]; team: TeamAgent[]; allowance: Allowance }

export type AgentStat = { key: string; label: string; value: number; unit?: 'minutes' | 'count' }
/** read: sees only; draft: prepares, nothing goes out; ask: does it after your OK; act: does it, within its limits */
export type ScopeLevel = 'read' | 'draft' | 'ask' | 'act'
export type AgentScope = { label: string; level: ScopeLevel }
export type WorkRow = { when: string; what: string; result: string; proof: Proof | null }
export type Instruction = { id: string; agentId: string; text: string; position: number; createdBy: string; createdAt: string; updatedAt: string }
export type AgentDashboard = { agent: TeamAgent; stats: AgentStat[]; scopes: AgentScope[]; work: WorkRow[]; instructions: Instruction[] }

export type AutonomyResult = { agentId: string; autonomy: AgentAutonomy; changed: boolean; applied: string[] }

export type ChatAction = { label: string; needsYouId: string; decision: 'approve' | 'decline' }
export type ChatMessage = { id?: string; role: 'owner' | 'agent'; text: string; actions?: ChatAction[]; at?: string; agentId?: string | null }
export type ChatIntent = 'status' | 'today' | 'needs_you' | 'pause' | 'resume' | 'set_autonomy' | 'help' | 'unknown'

// ---------------------------------------------------------------- server functions

export { getWorkspace, setWorkspace, defaultWorkspace, setAgentAutonomy, pauseAgent, resumeAgent, listInstructions, addInstruction, updateInstruction, deleteInstruction } from './control'
export { needsYou, decideNeedsYou, doneWithProof, team, hero, allowance, agentDashboard, commandCenter, findAgent } from './feeds'
export { chat, chatHistory } from './chat'
export { instructionsFor } from './profiles'
