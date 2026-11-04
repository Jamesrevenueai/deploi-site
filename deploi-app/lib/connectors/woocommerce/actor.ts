/** Who may connect or disconnect a WooCommerce store: a merchant user of the organization (never staff). */
import { HttpError } from '../../store/request'
import type { Actor } from '../../engine/actor'

export function merchantFor(actor: Actor): { orgId: string; label: string; profileId: string | null } {
  if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff can view but not connect or disconnect a merchant store')
  return { orgId: actor.orgId, label: actor.label, profileId: actor.kind === 'profile' ? actor.session.uid : null }
}
