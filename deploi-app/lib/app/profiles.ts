/**
 * Agent profiles and standing instructions: the small shared state the agent loop, Office runs and library runs
 * read (lib/app/contract.ts is the full view for the app). Kept free of the loop's imports so lib/events/loop.ts
 * can depend on it.
 *
 * An agent is named by a stable ref across kinds:
 *   store:<library key>        a store agent of the agent library / commerce pack (e.g. store:inventory_watcher)
 *   store:<engine agent uuid>  a store agent the owner built on the correction engine
 *   office:<office agent uuid> an Office agent (lib/office)
 *   pack:<pack agent key>      an agent of a non-commerce pack (lib/packs)
 *
 * Colour: one of PALETTE, assigned on first sight in the order agents are first seen (round-robin), then stored.
 * Autonomy: 'act_then_tell' until the owner chooses; only an explicit choice (autonomy_set_at) overrides the
 * organization's action modes, so a profile created on first sight never widens what an agent may do.
 */
import { admin, type Db } from '../db'
import { PACK_AGENTS } from '../packs/registry'

export const PALETTE = ['#4F6BFF', '#FF5FA2', '#FF8A3D', '#8B5CF6', '#14B8A6', '#E0A800'] as const
export type AgentColor = (typeof PALETTE)[number]
export const AUTONOMY_LEVELS = ['ask_first', 'act_then_tell', 'autonomous'] as const
export type AgentAutonomy = (typeof AUTONOMY_LEVELS)[number]
export const DEFAULT_AUTONOMY: AgentAutonomy = 'act_then_tell'
export const isAutonomy = (v: unknown): v is AgentAutonomy => typeof v === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(v)

export const AGENT_REF = /^(store|office|pack):[A-Za-z0-9_-]{1,100}$/
export const INSTRUCTION_MAX = 500
export const MAX_INSTRUCTIONS = 20

export type AgentProfileRow = { org_id: string; agent_ref: string; seq: number; color: AgentColor; autonomy: AgentAutonomy; autonomy_set_by: string | null; autonomy_set_at: string | null; paused_at: string | null; paused_by: string | null; created_at: string; updated_at: string }

/** The agent ref of a loop's agent key: commerce pack agents are store agents, other pack agents pack agents; null for any other key. */
export function loopAgentRef(agentKey: string): string | null {
  const a = PACK_AGENTS.find(x => x.key === agentKey)
  if (!a) return null
  return a.pack === 'commerce' ? `store:${a.key}` : `pack:${a.key}`
}

/**
 * Make sure every ref has a profile, in the order given (the caller passes agents in creation order): a new
 * ref takes the next sequence number and PALETTE[seq % 6]. Idempotent; serialised per organization.
 */
export async function ensureProfiles(db: Db, orgId: string, refs: string[]): Promise<Map<string, AgentProfileRow>> {
  const want = [...new Set(refs.filter(r => AGENT_REF.test(r)))]
  let rows = await db.query<AgentProfileRow>('select * from agent_profiles where org_id = $1', [orgId])
  const missing = want.filter(r => !rows.some(x => x.agent_ref === r))
  if (missing.length) {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 6464))`, [`agent-profiles:${orgId}`])
    rows = await db.query<AgentProfileRow>('select * from agent_profiles where org_id = $1', [orgId])
    let next = rows.reduce((m, r) => Math.max(m, r.seq + 1), 0)
    for (const ref of want) {
      if (rows.some(x => x.agent_ref === ref)) continue
      const r = await db.one<AgentProfileRow>(`insert into agent_profiles (org_id, agent_ref, seq, color) values ($1,$2,$3,$4) on conflict (org_id, agent_ref) do nothing returning *`,
        [orgId, ref, next, PALETTE[next % PALETTE.length]])
      if (r) { rows.push(r); next++ }
    }
  }
  return new Map(rows.map(r => [r.agent_ref, r]))
}

/** One agent's profile, or null when it was never seen. */
export async function profileFor(db: Db, orgId: string, ref: string): Promise<AgentProfileRow | null> {
  if (!AGENT_REF.test(ref)) return null
  return db.one<AgentProfileRow>('select * from agent_profiles where org_id = $1 and agent_ref = $2', [orgId, ref])
}

/** The owner's standing instructions for one agent, in order (plain text, each at most 500 characters). */
export async function instructionsFor(orgId: string, agentRef: string, db?: Db): Promise<string[]> {
  if (!AGENT_REF.test(agentRef)) return []
  const q = (d: Db) => d.query<{ text: string }>('select text from agent_instructions where org_id = $1 and agent_ref = $2 order by position, created_at limit $3', [orgId, agentRef, MAX_INSTRUCTIONS])
  return (await (db ? q(db) : admin(q))).map(r => r.text)
}

/** What the loop needs about an agent: the owner's explicit autonomy level (null: none chosen), pause, instructions. */
export type LoopAgentState = { agentRef: string | null; autonomy: AgentAutonomy | null; paused: boolean; instructions: string[] }
export async function loopAgentState(orgId: string, agentKey: string): Promise<LoopAgentState> {
  const ref = loopAgentRef(agentKey)
  if (!ref) return { agentRef: null, autonomy: null, paused: false, instructions: [] }
  return admin(async db => {
    const p = await profileFor(db, orgId, ref)
    return { agentRef: ref, autonomy: p?.autonomy_set_at ? p.autonomy : null, paused: Boolean(p?.paused_at), instructions: await instructionsFor(orgId, ref, db) }
  })
}
