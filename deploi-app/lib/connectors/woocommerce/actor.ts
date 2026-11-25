/** Who may connect or disconnect a WooCommerce store: an owner or admin of the organization (never staff; F-08). */
import { HttpError } from '../../store/request'
import type { Actor } from '../../engine/actor'
import { assertCan } from '../../platform/rbac'

export async function merchantFor(actor: Actor): Promise<{ orgId: string; label: string; profileId: string | null }> {
  if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff can view but not connect or disconnect a merchant store')
  await assertCan(actor, actor.orgId, 'connect')
  return { orgId: actor.orgId, label: actor.label, profileId: actor.kind === 'profile' ? actor.session.uid : null }
}
