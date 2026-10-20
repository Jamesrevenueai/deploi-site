/** Owner-conversation gate: held calls toward a goal of 10. Used by sections 4 and 8. */
import type { Db } from '../db'
import { HELD_STAGES } from './stages'

export const CONVERSATION_GOAL = 10

const HELD_SQL = `
  select p.id, p.agency_name, p.owner_name, p.county, p.stage::text as stage, p.biggest_leak,
         coalesce((select min(t.at) from touches t where t.prospect_id = p.id and t.channel = 'call' and t.meta->>'outcome' = 'held'), p.updated_at) as held_at
  from prospects p
  where p.stage = any($1::prospect_stage[])
     or exists (select 1 from touches t where t.prospect_id = p.id and t.channel = 'call' and t.meta->>'outcome' = 'held')`

export type HeldRow = { id: string; agency_name: string; owner_name: string | null; county: string | null; stage: string; biggest_leak: string | null; held_at: string }

export async function listHeld(db: Db): Promise<HeldRow[]> {
  return db.query<HeldRow>(`${HELD_SQL} order by held_at asc`, [HELD_STAGES])
}

export async function getConversationGate(db: Db): Promise<{ held: number; goal: number; open: boolean }> {
  const row = await db.one<{ n: string }>(`select count(*)::text as n from (${HELD_SQL}) h`, [HELD_STAGES])
  const held = Number(row?.n ?? 0)
  return { held, goal: CONVERSATION_GOAL, open: held >= CONVERSATION_GOAL }
}
