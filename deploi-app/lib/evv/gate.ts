import type { Db } from '../db'

export const CONVERSATION_GOAL = 10
export const HELD_STAGES = ['call_held', 'assessment_sold', 'build_sold', 'retainer'] as const

/** Held owner conversations so far. Real connector work starts at CONVERSATION_GOAL. */
export async function heldConversations(db: Db): Promise<number> {
  const r = await db.one<{ n: string }>(`select count(*)::text as n from prospects where stage = any($1::prospect_stage[])`, [HELD_STAGES])
  return Number(r?.n ?? 0)
}
