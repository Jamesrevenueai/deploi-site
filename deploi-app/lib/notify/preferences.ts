/**
 * How each person in an organization gets agent updates. Email is on by default; text and voice notes are off
 * until the person turns them on and gives a phone number. digest 'daily' keeps routine updates for the
 * morning report; an update that needs the owner (a decision or a warning) still goes out at once.
 * Anyone in the organization sets their own preferences; owners and admins are the ones updates go to.
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { actorRole } from '../platform/rbac'
import { normalizePhone } from './channels'

export type NotifyPrefs = { email: boolean; text: boolean; voice: boolean; phone: string | null; digest: 'off' | 'daily' }
export const DEFAULT_PREFS: NotifyPrefs = { email: true, text: false, voice: false, phone: null, digest: 'off' }

type PrefRow = { email_on: boolean; text_on: boolean; voice_on: boolean; phone: string | null; digest: 'off' | 'daily' }
const fromRow = (r: PrefRow | null): NotifyPrefs => (r ? { email: r.email_on, text: r.text_on, voice: r.voice_on, phone: r.phone, digest: r.digest } : { ...DEFAULT_PREFS })

export type Recipient = { profileId: string; email: string; name: string | null; role: string; prefs: NotifyPrefs }

/** The owners and admins of an organization, with their preferences (defaults where none are saved). */
export async function updateRecipients(db: Db, orgId: string): Promise<Recipient[]> {
  const rows = await db.query<{ id: string; email: string; full_name: string | null; org_role: string } & Partial<PrefRow> & { has_pref: boolean }>(
    `select p.id, lower(p.email) as email, p.full_name, p.org_role, n.email_on, n.text_on, n.voice_on, n.phone, n.digest, (n.id is not null) as has_pref
     from profiles p left join notify_preferences n on n.org_id = p.agency_id and n.profile_id = p.id
     where p.agency_id = $1 and p.org_role in ('owner', 'admin') and p.email is not null order by array_position(array['owner','admin'], p.org_role), p.created_at, p.id`, [orgId])
  return rows.map(r => ({ profileId: r.id, email: r.email, name: r.full_name, role: r.org_role, prefs: r.has_pref ? fromRow(r as PrefRow) : { ...DEFAULT_PREFS } }))
}

function self(actor: Actor): { orgId: string; uid: string } {
  if (actor.kind !== 'profile') throw new EngineError('forbidden', 'update preferences belong to a signed-in person in the organization')
  return { orgId: actor.orgId, uid: actor.session.uid }
}

export async function getMyPrefs(actor: Actor): Promise<NotifyPrefs & { role: string | null; receivesUpdates: boolean }> {
  const { orgId, uid } = self(actor)
  return admin(async db => {
    const role = await actorRole(actor, orgId, db)
    if (!role) throw new EngineError('forbidden', 'you are not a member of this organization')
    const r = await db.one<PrefRow>('select email_on, text_on, voice_on, phone, digest from notify_preferences where org_id = $1 and profile_id = $2', [orgId, uid])
    return { ...fromRow(r), role, receivesUpdates: role === 'owner' || role === 'admin' }
  })
}

/** Save your own preferences. Text or voice need a phone number in international form. */
export async function setMyPrefs(actor: Actor, input: Record<string, unknown>): Promise<NotifyPrefs> {
  const { orgId, uid } = self(actor)
  return admin(async db => {
    const role = await actorRole(actor, orgId, db)
    if (!role) throw new EngineError('forbidden', 'you are not a member of this organization')
    if (role === 'viewer') throw new EngineError('forbidden', 'your role (viewer) is read only')
    const cur = fromRow(await db.one<PrefRow>('select email_on, text_on, voice_on, phone, digest from notify_preferences where org_id = $1 and profile_id = $2', [orgId, uid]))
    const bool = (k: string, d: boolean) => (typeof input[k] === 'boolean' ? input[k] as boolean : d)
    let phone = cur.phone
    if ('phone' in input) {
      if (input.phone === null || input.phone === '') phone = null
      else { phone = normalizePhone(input.phone); if (!phone) throw new EngineError('invalid_input', 'enter the phone number in international form, e.g. +15551234567') }
    }
    const next: NotifyPrefs = { email: bool('email', cur.email), text: bool('text', cur.text), voice: bool('voice', cur.voice), phone, digest: input.digest === 'daily' ? 'daily' : input.digest === 'off' ? 'off' : cur.digest }
    if ((next.text || next.voice) && !next.phone) throw new EngineError('invalid_input', 'add a phone number to get text messages or voice notes')
    await db.query(
      `insert into notify_preferences (org_id, profile_id, email_on, text_on, voice_on, phone, digest) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (org_id, profile_id) do update set email_on = excluded.email_on, text_on = excluded.text_on, voice_on = excluded.voice_on, phone = excluded.phone, digest = excluded.digest, updated_at = now()`,
      [orgId, uid, next.email, next.text, next.voice, next.phone, next.digest])
    return next
  })
}
