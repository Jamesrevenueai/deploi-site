/**
 * Running an undo (/undo/<token>): only a signed-in owner or admin of the token's organization (assertCan
 * 'settings'); another organization's token reads as not found. A token works once: it is claimed atomically
 * before the reversal runs. A reversal that throws gives the claim back (the owner can try again); a reversal
 * that answers ok:false ("cannot be undone any more") uses the token. The result is recorded on the case and
 * in the audit trail.
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import { assertCan } from '../platform/rbac'
import { addNote } from '../cases'
import { hashUndoToken, undoKind } from './index'
import './kinds'
// undo kinds registered by packs
import '../events/agents'

export type UndoRow = { id: string; org_id: string; kind: string; payload: Record<string, unknown>; summary: string; case_id: string | null; agent_key: string | null; created_at: string; expires_at: string; used_at: string | null; used_by: string | null; result: { ok: boolean; detail: string } | null }
export type UndoPreview = { state: 'ready' | 'used' | 'expired' | 'not_found'; summary: string | null; caseRef: string | null; agentKey: string | null; createdAt: string | null; expiresAt: string | null; usedAt: string | null; result: UndoRow['result'] }

const TOKEN = /^u_[A-Za-z0-9_-]{20,64}$/

async function load(token: string): Promise<(UndoRow & { case_ref: string | null }) | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null
  return admin(db => db.one<UndoRow & { case_ref: string | null }>(`select u.id, u.org_id, u.kind, u.payload, u.summary, u.case_id, u.agent_key, u.created_at, u.expires_at, u.used_at, u.used_by, u.result, c.ref as case_ref
    from undo_tokens u left join cases c on c.id = u.case_id where u.token_hash = $1`, [hashUndoToken(token)]))
}

/** What the token would reverse, for the actor's organization only (anything else is not_found). */
export async function previewUndo(actor: Actor, token: string, now = new Date()): Promise<UndoPreview> {
  const none: UndoPreview = { state: 'not_found', summary: null, caseRef: null, agentKey: null, createdAt: null, expiresAt: null, usedAt: null, result: null }
  if (actor.kind === 'staff') return none
  const r = await load(token)
  if (!r || r.org_id !== actor.orgId) return none
  const state = r.used_at ? 'used' : new Date(r.expires_at) <= now ? 'expired' : 'ready'
  return { state, summary: r.summary, caseRef: r.case_ref, agentKey: r.agent_key, createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), usedAt: r.used_at ? new Date(r.used_at).toISOString() : null, result: r.result }
}

/** Reverse the change. Owner or admin of the token's organization; single use. */
export async function runUndo(actor: Actor, token: string, opts: { ip?: string | null; now?: Date } = {}): Promise<{ ok: boolean; detail: string; caseRef: string | null }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot undo a customer\'s change')
  const r = await load(token)
  if (!r || r.org_id !== actor.orgId) throw new EngineError('not_found', 'this undo link is not valid')
  await assertCan(actor, r.org_id, 'settings')
  const fn = undoKind(r.kind)
  if (!fn) throw new EngineError('not_found', 'this kind of change cannot be undone here')
  const now = opts.now ?? new Date()
  const claimed = await admin(db => db.one<{ id: string }>(`update undo_tokens set used_at = $3, used_by = $2 where id = $1 and used_at is null and expires_at > $3 returning id`, [r.id, actor.label.slice(0, 160), now.toISOString()]))
  if (!claimed) throw new EngineError(r.used_at ? 'not_pending' : 'expired', r.used_at ? 'this change was already undone' : 'this undo link expired')
  let result: { ok: boolean; detail: string }
  try {
    result = await admin(db => fn(db, { ...r.payload, orgId: r.org_id }))
    result = { ok: Boolean(result?.ok), detail: String(result?.detail ?? '').slice(0, 500) }
  } catch (e) {
    // a reversal that failed part way can be tried again: the claim is given back
    await admin(db => db.query('update undo_tokens set used_at = null, used_by = null, result = $2 where id = $1', [r.id, JSON.stringify({ ok: false, detail: `Could not undo: ${(e as Error).message.slice(0, 300)}` })]))
    throw new EngineError('not_retryable', `the change could not be undone right now: ${(e as Error).message.slice(0, 200)}`)
  }
  await admin(async db => {
    await db.query('update undo_tokens set result = $2 where id = $1', [r.id, JSON.stringify(result)])
    if (r.case_id) await addNote(db, r.case_id, `${result.ok ? 'Undone' : 'Undo did not complete'} by ${actor.label}: ${result.detail}`, actor.label).catch(() => {})
    await audit(db, { orgId: r.org_id, entityType: 'case', entityId: r.case_id, event: result.ok ? 'undo.done' : 'undo.refused', actor: actor.label, detail: { undo_id: r.id, kind: r.kind, detail: result.detail, ip: opts.ip ?? null } })
  })
  return { ...result, caseRef: r.case_ref }
}
