/**
 * Organization-level "stop all agents". While it is on, no agent of the organization runs, writes or
 * sends: every agent was paused when it was turned on, queued agent jobs were cancelled, new agent
 * jobs are refused, granting or resuming an agent is refused, and every send is held. Turning it off
 * does not restart anything: the merchant resumes each agent. Both directions are audited
 * (lib/agents/lifecycle.ts#stopAllAgents / #clearAgentStop).
 */
import type { Db } from '../db'

export type OrgControl = { org_id: string; agents_stopped: boolean; stop_reason: string | null; stopped_by: string | null; stopped_at: string | null; resumed_by: string | null; resumed_at: string | null }

/** Why agents of this organization may not act right now, or null. */
export async function orgStopReason(db: Db, orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null
  const r = await db.one<{ agents_stopped: boolean; stop_reason: string | null }>('select agents_stopped, stop_reason from org_controls where org_id = $1', [orgId])
  return r?.agents_stopped ? `all agents of this organization are stopped${r.stop_reason ? ` (${r.stop_reason})` : ''}` : null
}

export async function orgControl(db: Db, orgId: string): Promise<OrgControl | null> {
  return db.one<OrgControl>('select org_id, agents_stopped, stop_reason, stopped_by, stopped_at, resumed_by, resumed_at from org_controls where org_id = $1', [orgId])
}
