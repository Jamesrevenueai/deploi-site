/**
 * Undo registry. SHARED INTERFACE — owned by workstream W1.
 * An agent that makes a reversible change registers how to reverse it; the owner email links to /undo/<token>.
 *
 *  - registerUndo(kind, fn): how to reverse one kind of change. The runner calls fn(db, payload) with the
 *    service role, and always sets payload.orgId to the token's organization (a payload cannot name another
 *    organization); fn must check that every record it touches belongs to payload.orgId.
 *  - createUndo(...): stores a single-use, expiring token (only its SHA-256 is kept, table undo_tokens) and
 *    returns the token for the owner's link. Run it through lib/undo/run.ts (the /undo/<token> page).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db'

export type UndoFn = (db: Db, payload: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>
const kinds = new Map<string, UndoFn>()
export function registerUndo(kind: string, fn: UndoFn) { kinds.set(kind, fn) }
export function undoKind(kind: string) { return kinds.get(kind) ?? null }
export const registeredUndoKinds = () => [...kinds.keys()]

export const UNDO_KIND = /^[a-z][a-z0-9_.:-]{1,63}$/
export const DEFAULT_UNDO_TTL_MS = 7 * 86400e3
export const hashUndoToken = (token: string) => createHash('sha256').update(`deploi-undo:${token}`).digest('hex')
/** The app path the owner opens to undo a change. */
export const undoPath = (token: string) => `/undo/${encodeURIComponent(token)}`

export type CreateUndoInput = {
  orgId: string
  kind: string
  payload: Record<string, unknown>
  /** what will be reversed, in plain words (shown on the undo page) */
  summary: string
  caseId?: string | null
  agentKey?: string | null
  ttlMs?: number
  now?: Date
}

/** Store a single-use undo token and return it (the only time it exists in clear). */
export async function createUndo(i: CreateUndoInput, db?: Db): Promise<{ token: string; id: string; expiresAt: string }> {
  if (!UNDO_KIND.test(i.kind)) throw new Error(`invalid undo kind: ${i.kind}`)
  if (!/^[0-9a-f-]{36}$/i.test(i.orgId)) throw new Error('invalid organization id')
  const token = `u_${randomBytes(24).toString('base64url')}`
  const now = i.now ?? new Date()
  const expiresAt = new Date(now.getTime() + Math.min(Math.max(i.ttlMs ?? DEFAULT_UNDO_TTL_MS, 60_000), 90 * 86400e3)).toISOString()
  const run = (d: Db) => d.one<{ id: string }>(
    `insert into undo_tokens (org_id, token_hash, kind, payload, summary, case_id, agent_key, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [i.orgId, hashUndoToken(token), i.kind, JSON.stringify(i.payload ?? {}), String(i.summary ?? '').slice(0, 500), i.caseId ?? null, i.agentKey ? i.agentKey.slice(0, 120) : null, now.toISOString(), expiresAt])
  const { admin } = await import('../db')
  const row = db ? await run(db) : await admin(run)
  return { token, id: row!.id, expiresAt }
}
