/** People with each organization role in a merchant organization, as actors (cleaned up by removePeople). */
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import type { Actor } from '../../lib/engine/actor'
import type { OrgRole } from '../../lib/platform/rbac'
import type { NW } from '../merchant/helpers'

export async function person(m: typeof NW, role: OrgRole, tag = role): Promise<Actor & { kind: 'profile' }> {
  const email = `${tag}.${m === undefined ? 'x' : m.domain.split('.')[0]}@rbac.example`
  const uid = uuidFrom(`user:rbac:${m.org}:${tag}`)
  await admin(async db => {
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [uid, email])
    await db.query(`insert into profiles (id, email, role, agency_id, org_role) values ($1,$2,'client',$3,$4)
      on conflict (id) do update set agency_id = excluded.agency_id, org_role = excluded.org_role`, [uid, email, m.org, role])
    // an insert through the trigger may have derived another role; the explicit update wins
    await db.query('update profiles set org_role = $2 where id = $1', [uid, role])
  })
  return { kind: 'profile', session: { uid, email, role: 'client', agencyId: m.org, orgType: 'merchant' }, orgId: m.org, label: `user:${email}` }
}

export async function removePeople(m: typeof NW) {
  await admin(async db => {
    await db.query(`delete from auth.users where email like '%@rbac.example' and id in (select id from profiles where agency_id = $1 or agency_id is null)`, [m.org])
    await db.query(`update agencies set members_can_approve = false where id = $1`, [m.org])
  })
}
