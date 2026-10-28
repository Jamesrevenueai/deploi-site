/**
 * Merchant product demo: two synthetic merchant organizations, each with an owner login and a
 * synthetic Shopify store. Northwind's owner has confirmed the "stop selling at zero" rule;
 * Harbor's has not (the rule stays off until the owner answers the setup question).
 */
import { uuidFrom } from '../../lib/ids'
import { northwindState, harborState, NORTHWIND_DOMAIN, HARBOR_DOMAIN } from '../../lib/connectors/shopify/demo-store'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import type { SeedCtx } from './index'

export const MERCHANTS = [
  { key: 'northwind', name: 'Northwind Goods (synthetic)', email: 'owner@northwind-goods.example', domain: NORTHWIND_DOMAIN, tz: 'America/Chicago', state: northwindState, ruleOn: true },
  { key: 'harbor', name: 'Harbor Supply (synthetic)', email: 'owner@harbor-supply.example', domain: HARBOR_DOMAIN, tz: 'America/New_York', state: harborState, ruleOn: false },
]
const SCOPES = ['read_products', 'write_products', 'read_inventory', 'read_locations']

export async function seedArea({ c, counts }: SeedCtx) {
  for (const m of MERCHANTS) {
    const org = uuidFrom(`merchant:${m.key}`)
    await c.query(
      `insert into agencies (id, name, state, timezone, org_type) values ($1,$2,'',$3,'merchant')
       on conflict (id) do update set name = excluded.name, org_type = 'merchant', timezone = excluded.timezone`, [org, m.name, m.tz])
    let uid = (await c.query('select id from auth.users where lower(email) = lower($1)', [m.email])).rows[0]?.id as string | undefined
    if (!uid) {
      uid = uuidFrom(`user:merchant:${m.key}`)
      await c.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [uid, m.email])
    }
    await c.query(`insert into profiles (id, email, full_name, role, agency_id) values ($1,$2,$3,'client',$4)
      on conflict (id) do update set agency_id = excluded.agency_id, role = 'client'`, [uid, m.email, `${m.name.replace(' (synthetic)', '')} owner`, org])
    const conn = uuidFrom(`connection:${m.key}`)
    await c.query(
      `insert into store_connections (id, org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, installed_at)
       values ($1,$2,'shopify',$3,$4,'active',$5,'2026-10',true,$6,now())
       on conflict (id) do update set status = 'active', scopes = excluded.scopes, is_synthetic = true`, [conn, org, m.domain, m.name, SCOPES, m.tz])
    await c.query(`insert into synthetic_store_state (connection_id, state) values ($1,$2) on conflict (connection_id) do update set state = excluded.state, updated_at = now()`,
      [conn, JSON.stringify(m.state())])
    await c.query(
      `insert into merchant_rules (org_id, connection_id, check_key, enabled, config, updated_by) values ($1,$2,'shopify.oversell_policy',$3,$4,$5)
       on conflict (connection_id, check_key) do nothing`,
      [org, conn, m.ruleOn, JSON.stringify({ exemptTags: DEFAULT_EXEMPT_TAGS, exemptProductIds: [], flagInStockVariants: true }), m.ruleOn ? 'seed: owner confirmed the policy' : 'system:defaults'])
    await c.query(
      `insert into merchant_rules (org_id, connection_id, check_key, enabled, config, updated_by) values ($1,$2,'shopify.oversold_stop_selling',true,'{}','system:defaults')
       on conflict (connection_id, check_key) do nothing`, [org, conn])
    await c.query(`insert into app_subscriptions (org_id, connection_id, provider, plan_key, status, is_test)
      select $1,$2,'early_access','early_access','active',true where not exists (select 1 from app_subscriptions where connection_id = $2)`, [org, conn])
  }
  counts.merchant_orgs = MERCHANTS.length
}
