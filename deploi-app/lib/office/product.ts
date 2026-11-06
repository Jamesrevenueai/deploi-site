/**
 * Switching Deploi Office off: owner or admin only. Every Office agent is paused and its queued sends, bookings
 * and CRM writes are cancelled before the product is disabled, so nothing keeps acting; connections and history
 * are kept and switching it on again resumes nothing by itself.
 */
import { admin } from '../db'
import { disableProduct } from '../products'
import { assertCan } from '../platform/rbac'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { officeAudit } from './audit'
import { cancelAgentActions } from './actions'

export async function disableOffice(actor: Actor): Promise<{ agentsPaused: number; actionsCancelled: number }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot switch a customer\'s product off')
  await assertCan(actor, actor.orgId, 'settings')
  return admin(async db => {
    const agents = await db.query<{ id: string }>(`update office_agents set status = 'paused', next_run_at = null where org_id = $1 and status = 'active' returning id`, [actor.orgId])
    let actionsCancelled = 0
    for (const a of agents) actionsCancelled += (await cancelAgentActions(db, a.id, 'Deploi Office was switched off; queued items are not carried out', false)).actions
    await disableProduct(db, actor.orgId, 'office')
    await officeAudit(db, { orgId: actor.orgId, entityType: 'office_agent', event: 'product.disabled', actor: actor.label, detail: { agents_paused: agents.length, actions_cancelled: actionsCancelled } })
    return { agentsPaused: agents.length, actionsCancelled }
  })
}
