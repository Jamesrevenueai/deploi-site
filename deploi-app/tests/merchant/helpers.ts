import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { setSyntheticState, getSyntheticState, type SynthState } from '../../lib/connectors/shopify/synthetic'
import { northwindState, harborState, NORTHWIND_DOMAIN, HARBOR_DOMAIN } from '../../lib/connectors/shopify/demo-store'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import type { Actor } from '../../lib/engine/actor'
import type { Session } from '../../lib/session'
import '../../lib/connectors'

export const NW = { org: uuidFrom('merchant:northwind'), conn: uuidFrom('connection:northwind'), uid: uuidFrom('user:merchant:northwind'), email: 'owner@northwind-goods.example', domain: NORTHWIND_DOMAIN }
export const HB = { org: uuidFrom('merchant:harbor'), conn: uuidFrom('connection:harbor'), uid: uuidFrom('user:merchant:harbor'), email: 'owner@harbor-supply.example', domain: HARBOR_DOMAIN }

export async function uidFor(email: string) {
  return (await admin(db => db.one<{ id: string }>('select id from profiles where lower(email) = lower($1)', [email])))!.id
}

export async function merchantActor(m: typeof NW): Promise<Actor> {
  const uid = await uidFor(m.email)
  const session: Session = { uid, email: m.email, role: 'client', agencyId: m.org, orgType: 'merchant' }
  return { kind: 'profile', session, orgId: m.org, label: `user:${m.email}` }
}

export async function staffActor(): Promise<Actor> {
  const uid = await uidFor('hello@getdeploi.com')
  return { kind: 'staff', session: { uid, email: 'hello@getdeploi.com', role: 'staff', agencyId: null }, label: 'staff:hello@getdeploi.com' }
}

/** Reset a merchant's engine state and synthetic store to the seeded starting point. */
export async function resetMerchant(m: typeof NW, opts: { ruleOn?: boolean; state?: SynthState } = {}) {
  await admin(async db => {
    await db.query('delete from agent_runs where agent_id in (select id from agents where connection_id = $1)', [m.conn])
    await db.query('delete from executions where connection_id = $1', [m.conn])
    await db.query('delete from approvals where proposal_id in (select id from proposals where connection_id = $1)', [m.conn])
    await db.query('delete from proposals where connection_id = $1', [m.conn])
    await db.query('delete from issues where connection_id = $1', [m.conn])
    await db.query('delete from scans where connection_id = $1', [m.conn])
    await db.query('update agents set active_policy_id = null where connection_id = $1', [m.conn])
    await db.query('delete from agents where connection_id = $1', [m.conn])
    await db.query('delete from reference_sources where connection_id = $1', [m.conn])
    await db.query(`update store_connections set status = 'active', is_synthetic = true, currency = 'USD', scopes = $2 where id = $1`, [m.conn, ['read_products', 'write_products', 'read_inventory', 'read_locations', 'read_publications', 'write_publications']])
    await db.query('delete from merchant_rules where connection_id = $1', [m.conn])
    await db.query(`insert into merchant_rules (org_id, connection_id, check_key, enabled, config, updated_by) values ($1,$2,'shopify.oversell_policy',$3,$4,'test'),($1,$2,'shopify.oversold_stop_selling',true,'{}','test')`,
      [m.org, m.conn, opts.ruleOn ?? true, JSON.stringify({ exemptTags: DEFAULT_EXEMPT_TAGS, exemptProductIds: [], flagInStockVariants: true })])
  })
  await setSyntheticState(m.conn, opts.state ?? (m === NW ? northwindState() : harborState()))
}

export const store = (m: typeof NW) => getSyntheticState(m.conn)
