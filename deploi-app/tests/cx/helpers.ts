import '../merchant/env'
import { admin } from '../../lib/db'
import { NW, HB, resetMerchant } from '../merchant/helpers'

export { NW, HB }

/** A merchant with no agents, no library switches, an empty setup wizard, and only Commerce enabled. */
export async function resetCx(m: typeof NW) {
  await resetMerchant(m)
  await admin(async db => {
    for (const t of ['library_actions', 'library_auto_run_grants', 'library_switches']) await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query(`update agencies set onboarding = '{}'::jsonb where id = $1`, [m.org])
    await db.query(`insert into org_products (org_id, product, enabled_by) values ($1, 'commerce', 'test') on conflict (org_id, product) do update set status = 'active', disabled_at = null`, [m.org])
    await db.query(`update org_products set status = 'disabled', disabled_at = now() where org_id = $1 and product = 'office'`, [m.org])
  })
}
