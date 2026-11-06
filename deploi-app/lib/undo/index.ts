/**
 * Undo registry. SHARED INTERFACE — owned by workstream W1.
 * An agent that makes a reversible change registers how to reverse it; the owner email links to /undo/<token>.
 */
import type { Db } from '../db'

export type UndoFn = (db: Db, payload: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>
const kinds = new Map<string, UndoFn>()
export function registerUndo(kind: string, fn: UndoFn) { kinds.set(kind, fn) }
export function undoKind(kind: string) { return kinds.get(kind) ?? null }
