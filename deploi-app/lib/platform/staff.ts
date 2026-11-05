/** Staff-only API guard: a signed-in Deploi staff session (never a merchant, never an embedded Shopify session). */
import { resolveActor, HttpError } from '../store/request'
import type { Actor } from '../engine/actor'

export async function requireStaffApi(req: Request, opts: { mutating?: boolean } = {}): Promise<Extract<Actor, { kind: 'staff' }>> {
  const actor = await resolveActor(req, opts)
  if (actor.kind !== 'staff') throw new HttpError(403, 'forbidden', 'staff only')
  return actor
}
