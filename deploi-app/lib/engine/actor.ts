/**
 * Who is acting. Merchant users act for exactly one organization: either a signed-in profile whose
 * organization is a merchant, or a Shopify admin user whose session token the server verified.
 * Deploi staff can read every organization (support) but can never approve a merchant's change.
 */
import { withUser, withOrgSession, type Db } from '../db'
import type { Session } from '../session'
import { EngineError } from './errors'

export type Actor =
  | { kind: 'profile'; session: Session; orgId: string; label: string }
  | { kind: 'shopify_user'; orgId: string; shop: string; userId: string; label: string }
  | { kind: 'staff'; session: Session; label: string }

export function actorLabel(a: Actor): string { return a.label }

/** Run a read under the actor's identity with RLS enforced. */
export function withActor<T>(actor: Actor, fn: (db: Db) => Promise<T>, opts: { ip?: string | null } = {}): Promise<T> {
  if (actor.kind === 'shopify_user') return withOrgSession(actor.orgId, actor.label, fn, opts)
  return withUser(actor.session, fn, opts)
}

/** Only a merchant user of the owning organization may approve, retry, dismiss or change rules. */
export function assertMerchant(actor: Actor, orgId: string): asserts actor is Exclude<Actor, { kind: 'staff' }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not approve or change a merchant store')
  if (actor.orgId !== orgId) throw new EngineError('forbidden', 'not your organization')
}

export function approverKind(actor: Exclude<Actor, { kind: 'staff' }>): 'profile' | 'shopify_user' {
  return actor.kind
}
