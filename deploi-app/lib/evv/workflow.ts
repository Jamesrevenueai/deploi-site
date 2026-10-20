/** Fix workflow: close an exception with a note. Runs as the signed-in user (RLS applies). */
import type { Db } from '../db'

export async function correctException(db: Db, id: string, note: string): Promise<boolean> {
  const n = note.trim()
  if (!n) throw new Error('A note is required')
  const r = await db.query<{ id: string }>(
    `update evv_exceptions set status = 'corrected', corrected_at = now(), correction_note = $2 where id = $1 and status = 'open' returning id`, [id, n])
  return r.length === 1
}

export async function dismissException(db: Db, id: string, note: string): Promise<boolean> {
  const n = note.trim()
  if (!n) throw new Error('A note is required')
  const r = await db.query<{ id: string }>(
    `update evv_exceptions set status = 'dismissed', corrected_at = now(), correction_note = $2 where id = $1 and status = 'open' returning id`, [id, n])
  return r.length === 1
}

export async function reopenException(db: Db, id: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `update evv_exceptions set status = 'open', corrected_at = null, correction_note = null where id = $1 and status <> 'open' returning id`, [id])
  return r.length === 1
}
