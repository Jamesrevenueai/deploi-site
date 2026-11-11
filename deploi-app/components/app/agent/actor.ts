/**
 * The signed-in merchant user as an engine Actor, for the agent dashboard's server page and its server action.
 * Mirrors lib/store/request.ts resolveActor for a cookie session (the organization comes from the session,
 * never from the request): staff and accounts without a store organization get no actor.
 */
import { getSession } from '@/lib/auth'
import { AGENT_REF } from '@/lib/app/profiles'
import type { Actor } from '@/lib/engine/actor'
import type { Session } from '@/lib/session'

export function actorOf(s: Session): Extract<Actor, { kind: 'profile' }> | null {
  if (s.role === 'staff' || s.orgType !== 'merchant' || !s.agencyId) return null
  return { kind: 'profile', session: s, orgId: s.agencyId, label: `user:${s.email}` }
}

export async function sessionActor(): Promise<Extract<Actor, { kind: 'profile' }> | null> {
  const s = await getSession()
  return s ? actorOf(s) : null
}

/** A TeamAgent id from the route segment (URL-encoded or not), or null when it cannot be one. */
export function agentIdFrom(raw: string): string | null {
  let id = raw
  try { if (id.includes('%')) id = decodeURIComponent(id) } catch { return null }
  return AGENT_REF.test(id) ? id : null
}
