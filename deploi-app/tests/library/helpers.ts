import '../merchant/env'
process.env.AGENT_MAIL_DOMAIN ||= 'agents.getdeploi.test'
import { admin } from '../../lib/db'
import { NW, HB, resetMerchant } from '../merchant/helpers'
import type { TierKey } from '../../lib/library/config'

export { NW, HB }

/** A clean team for the merchant: no switches, grants, actions, usage or chat; the tier set; the synthetic store reset. */
export async function resetLibrary(m: typeof NW, tier: TierKey = 'pro') {
  await resetMerchant(m)
  await admin(async db => {
    for (const t of ['library_chat_messages', 'library_usage', 'library_actions', 'library_auto_run_grants', 'library_switches', 'custom_agents']) await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query(`update agencies set plan_tier = $2, onboarding = '{}'::jsonb where id = $1`, [m.org, tier])
  })
}

export const actionsOf = (m: typeof NW, agentKey: string) => admin(db => db.query<{ id: string; action_type: string; status: string; mode: string; proof: Record<string, unknown> | null; payload: Record<string, unknown>; permission_basis: string | null; status_reason: string | null }>('select id, action_type, status, mode, proof, payload, permission_basis, status_reason from library_actions where org_id = $1 and agent_key = $2 order by created_at', [m.org, agentKey]))
