/**
 * First run for a brand-new account. A person who signs in with no organization (and no invitation link)
 * gets an organization of their own, created here by server code, with them as its owner. Nothing the person
 * controls (user_metadata, a request field naming an organization) can choose which organization they join or
 * the role they get: the only inputs are the business name and time zone of the NEW organization.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import type { Session } from '../session'
import { setAppMetadata } from '../supabase/admin-api'
import { validTimezone } from '../library/onboarding'

export type CreatedOrg = { orgId: string; created: boolean; appMetadata: 'recorded' | 'skipped' | 'failed' | 'unchanged' }

export async function createOwnOrganization(session: Session, input: { name: unknown; timezone?: unknown }): Promise<CreatedOrg> {
  if (session.role !== 'client') throw new EngineError('forbidden', 'Deploi staff accounts do not own a customer organization')
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 120) throw new EngineError('invalid_input', 'business name must be 1 to 120 characters')
  const tz = typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'UTC'
  if (!validTimezone(tz)) throw new EngineError('invalid_input', 'choose a valid time zone')
  const r = await admin(async db => {
    const p = await db.one<{ agency_id: string | null }>('select agency_id from profiles where id = $1 for update', [session.uid])
    if (!p) throw new EngineError('not_found', 'no profile for this sign-in')
    // already in an organization (a second click, or an invitation accepted meanwhile): nothing new is created
    if (p.agency_id) return { orgId: p.agency_id, created: false }
    const wizard = { business: { name, timezone: tz, savedAt: new Date().toISOString() } }
    const org = (await db.one<{ id: string }>(`insert into agencies (name, state, timezone, org_type, onboarding) values ($1, '', $2, 'merchant', $3) returning id`,
      [name, tz, JSON.stringify({ wizard })]))!
    await db.query(`update profiles set agency_id = $2, org_role = 'owner' where id = $1`, [session.uid, org.id])
    await audit(db, { orgId: org.id, entityType: 'org', entityId: org.id, event: 'org.created', actor: `user:${session.email}`, detail: { owner: session.uid, source: 'sign_up' } })
    return { orgId: org.id, created: true }
  })
  if (!r.created) return { ...r, appMetadata: 'unchanged' }
  const meta = await setAppMetadata(session.uid, { agency_id: r.orgId, role: 'client' })
  return { ...r, appMetadata: meta.ok ? 'recorded' : meta.skipped ? 'skipped' : 'failed' }
}
