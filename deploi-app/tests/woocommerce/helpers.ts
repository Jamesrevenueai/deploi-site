/** Shared setup for WooCommerce tests: a synthetic WooCommerce store connected to the Northwind organization. */
import '../merchant/env'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { saveReference, type ReferenceKind } from '../../lib/agents/references'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { setWooSyntheticState, getWooSyntheticState, type WooSynthState } from '../../lib/connectors/woocommerce/synthetic'
import { wooDemoState, WOO_DEMO_SITE } from '../../lib/connectors/woocommerce/demo-store'
import { wooClientHooks } from '../../lib/connectors/woocommerce/client'
import type { Actor } from '../../lib/engine/actor'
import { NW } from '../merchant/helpers'
import '../../lib/connectors'

process.env.PLAN_MAX_AGENTS ||= '200'
// keep read retries fast in tests (the bound on attempts is what is tested)
wooClientHooks.sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 5)))

export const WOO = { org: NW.org, conn: uuidFrom('connection:northwind-woo-synthetic'), site: WOO_DEMO_SITE }
export const UNTIL = () => new Date(Date.now() + 300 * 864e5).toISOString()

export async function clearConnection(connId: string) {
  await admin(async db => {
    await db.query('delete from agent_runs where agent_id in (select id from agents where connection_id = $1)', [connId])
    await db.query('delete from executions where connection_id = $1', [connId])
    await db.query('delete from approvals where proposal_id in (select id from proposals where connection_id = $1)', [connId])
    await db.query('delete from proposals where connection_id = $1', [connId])
    await db.query('delete from issues where connection_id = $1', [connId])
    await db.query('delete from scans where connection_id = $1', [connId])
    await db.query('update agents set active_policy_id = null where connection_id = $1', [connId])
    await db.query('delete from agents where connection_id = $1', [connId])
    await db.query('delete from reference_sources where connection_id = $1', [connId])
    await db.query('delete from merchant_rules where connection_id = $1', [connId])
    await db.query('delete from webhook_receipts where connection_id = $1', [connId])
  })
}

/** Reset the synthetic WooCommerce store and every engine row on it. */
export async function resetWoo(state: WooSynthState = wooDemoState()) {
  await clearConnection(WOO.conn)
  await admin(async db => {
    await db.query(`insert into store_connections (id, org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, currency, installed_at)
      values ($1,$2,'woocommerce',$3,'Northwind Woo (synthetic)','active',$4,'wc/v3',true,'USD',now())
      on conflict (id) do update set status = 'active', scopes = excluded.scopes, is_synthetic = true, currency = 'USD', org_id = excluded.org_id`, [WOO.conn, WOO.org, WOO.site, ['read', 'write']])
    await db.query('delete from woo_connections where connection_id = $1', [WOO.conn])
  })
  await setWooSyntheticState(WOO.conn, state)
}

export async function dropWoo() {
  await clearConnection(WOO.conn)
  await admin(db => db.query('delete from store_connections where id = $1', [WOO.conn]))
}

export const wooStore = async () => (await getWooSyntheticState(WOO.conn))!

export async function upload(actor: Actor, kind: ReferenceKind, csv: string, name: string = kind) {
  const r = await admin(db => saveReference(db, { orgId: WOO.org, connectionId: WOO.conn, kind, name, csv, actor: actor.label }))
  if (!r.ok) throw new Error('upload failed: ' + JSON.stringify(r.errors))
  return r.source.id
}

export async function wooAgent(actor: Actor, name: string, policy: Record<string, unknown>) {
  const c = await createAgent(actor, { name, taskText: `${name} task`, policy: { connectionId: WOO.conn, productScope: { mode: 'all' }, ...policy } })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}
