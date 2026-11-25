/**
 * The owner closing a case themselves. Only kinds that register here can be closed this way: a restock
 * request the owner no longer needs, an informational market signal the owner has read, a library agent's
 * piece of work. A close is `cancelled` with the owner's reason; it is never a resolution (resolution needs
 * verification evidence, lib/cases/index.ts). Every other kind is decided where its work lives.
 */
import { admin, type Db } from '../db'
import { EngineError } from '../engine/errors'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { TERMINAL, transitionCase, type CaseRow } from './index'

export type CaseCloseHandler = {
  /** the button label */
  label: string
  /** the owner must say why (an acknowledgement needs no reason) */
  needsReason: boolean
  /** the reason recorded when none is needed (e.g. "acknowledged") */
  fixedReason?: string
  /** also update the underlying record (e.g. mark a competitor finding seen); same transaction */
  onClose?: (db: Db, c: CaseRow, actor: Exclude<Actor, { kind: 'staff' }>) => Promise<void>
}
const handlers = new Map<string, CaseCloseHandler>()
export function registerCaseClose(kind: string, h: CaseCloseHandler) { handlers.set(kind, h) }
export const closeHandler = (kind: string) => handlers.get(kind) ?? null
export const closableKinds = () => [...handlers.keys()]

/** Close one case of the actor's own organization (cancelled, with the reason). */
export async function closeCase(actor: Actor, idOrRef: string, input: { reason?: string | null }): Promise<CaseRow> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff do not decide on cases')
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from cases where org_id = $1 and (id::text = $2 or ref = $2)', [actor.orgId, idOrRef]))
  if (!visible) throw new EngineError('not_found', 'case not found')
  assertMerchant(actor, visible.org_id)
  return admin(async db => {
    const c = await db.one<CaseRow>('select * from cases where id = $1 for update', [visible.id])
    if (!c) throw new EngineError('not_found', 'case not found')
    if (TERMINAL.includes(c.status)) throw new EngineError('not_pending', `this case is already ${c.status}`)
    const h = handlers.get(c.kind)
    if (!h) throw new EngineError('invalid_input', 'this case is decided where its work lives, not closed here')
    const reason = (h.fixedReason ?? String(input.reason ?? '')).trim().slice(0, 500)
    if (!reason) throw new EngineError('invalid_input', 'say why you are closing it')
    await h.onClose?.(db, c, actor)
    return transitionCase(db, c.id, { to: 'cancelled', actor: actor.label, reason: h.fixedReason ? reason : `Closed by you: ${reason}`, nextCheckAt: null, nextAction: null })
  })
}
