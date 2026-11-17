import '../merchant/env'
import { admin } from '../../lib/db'
import { NW, HB, resetMerchant, merchantActor, staffActor } from '../merchant/helpers'
import { resetOffice } from '../office/helpers'

export { NW, HB, merchantActor, staffActor }

/** Remove every discovery record and every case of the merchants; reset the synthetic stores and Office. */
export async function resetDiscovery(m: typeof NW, opts: { office?: boolean } = {}) {
  await admin(async db => {
    await db.query('delete from discovery_agents where org_id = $1', [m.org])
    await db.query('delete from business_profiles where org_id = $1', [m.org])
    await db.query('delete from discovery_runs where org_id = $1', [m.org])
    await db.query('delete from cases where org_id = $1', [m.org])
    await db.query(`delete from jobs where org_id = $1 and kind in ('discovery.run', 'case.check')`, [m.org])
    await db.query('update org_controls set agents_stopped = false where org_id = $1', [m.org])
    await db.query(`update agencies set onboarding = '{}'::jsonb where id = $1`, [m.org])
  })
  await resetOffice(m, { enable: opts.office ?? false })
  await resetMerchant(m)
}

export const casesOf = (org: string) => admin(db => db.query<{ id: string; kind: string; dedupe_key: string; status: string; source_app: string; next_check_at: string | null }>(
  'select id, kind, dedupe_key, status, source_app, next_check_at from cases where org_id = $1 order by opened_at', [org]))

export const agentsOf = (org: string) => admin(db => db.query<{ id: string; name: string; status: string; approval_mode: string; email_permission: string | null }>(
  `select a.id, a.name, a.status, p.policy->>'approvalMode' as approval_mode, p.policy->'email'->>'permission' as email_permission
   from agents a join agent_policies p on p.agent_id = a.id and p.version = (select max(version) from agent_policies where agent_id = a.id)
   where a.org_id = $1 and a.status <> 'deleted' order by a.created_at`, [org]))
