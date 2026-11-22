import type { Actor } from '@/lib/engine/actor'
import type { Session } from '@/lib/session'

/** The signed-in merchant user as an actor; staff and accounts without a business have none. */
export function undoActorFor(s: Session): Exclude<Actor, { kind: 'staff' }> | null {
  if (s.role === 'staff' || s.orgType !== 'merchant' || !s.agencyId) return null
  return { kind: 'profile', session: s, orgId: s.agencyId, label: `user:${s.email}` }
}
