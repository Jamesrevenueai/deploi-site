/** Shared setup for the infrastructure tests: the seeded merchants, cleanup of every table these tests touch. */
import '../merchant/env'
import { admin } from '../../lib/db'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB } from '../merchant/helpers'

export { NW, HB }
export const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
export const UNTIL = new Date(Date.now() + 300 * 864e5).toISOString()

/** A granted store agent on the merchant's synthetic store. */
export async function grantedAgent(actor: Actor, m: typeof NW, name: string, policy: Record<string, unknown> = {}) {
  const c = await createAgent(actor, { name, taskText: `${name} task`, policy: { connectionId: m.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'review', ...policy } })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}

/** Remove what these tests leave behind so no other suite sees it (stops, suppressions, test jobs, inbox state). */
export async function cleanInfra() {
  await admin(async db => {
    await db.query(`delete from jobs where kind like 'test.%' or org_id = any($1::uuid[])`, [[NW.org, HB.org]])
    await db.query(`delete from org_controls where org_id = any($1::uuid[])`, [[NW.org, HB.org]])
    await db.query(`delete from email_suppressions where org_id = any($1::uuid[])`, [[NW.org, HB.org]])
    await db.query(`delete from email_thread_state where org_id = any($1::uuid[])`, [[NW.org, HB.org]])
  })
}
