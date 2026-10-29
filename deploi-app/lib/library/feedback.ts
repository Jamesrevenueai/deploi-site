/** The feedback button for private-beta stores. Stored for staff to read; nothing is emailed. */
import { admin } from '../db'
import { withActor, type Actor } from '../engine/actor'
import { LibraryError } from './errors'

export async function submitFeedback(actor: Actor, input: { page?: unknown; mood?: unknown; message?: unknown }) {
  const message = String(input.message ?? '').trim()
  if (!message || message.length > 4000) throw new LibraryError('invalid_input', 'write a message of up to 4000 characters')
  const mood = input.mood === 'happy' || input.mood === 'neutral' || input.mood === 'unhappy' ? input.mood : null
  const page = String(input.page ?? '').slice(0, 200)
  const orgId = actor.kind === 'staff' ? null : actor.orgId
  const row = await admin(db => db.one<{ id: string; created_at: string }>('insert into beta_feedback (org_id, page, mood, message, created_by) values ($1,$2,$3,$4,$5) returning id, created_at', [orgId, page, mood, message, actor.label]))
  return { id: row!.id, createdAt: row!.created_at }
}

export async function listFeedback(actor: Actor, limit = 100) {
  return withActor(actor, db => db.query<{ id: string; org_id: string | null; page: string; mood: string | null; message: string; created_by: string; created_at: string; org_name: string | null }>(
    'select f.id, f.org_id, f.page, f.mood, f.message, f.created_by, f.created_at, g.name as org_name from beta_feedback f left join agencies g on g.id = f.org_id order by f.created_at desc limit $1', [Math.min(limit, 500)]))
}
