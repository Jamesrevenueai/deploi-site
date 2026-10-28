/**
 * Merchant product demo: two synthetic merchant organizations, each with an owner login and a
 * synthetic Shopify store. Northwind's owner has confirmed the "stop selling at zero" rule;
 * Harbor's has not (the rule stays off until the owner answers the setup question).
 */
import { uuidFrom } from '../../lib/ids'
import { northwindState, harborState, NORTHWIND_DOMAIN, HARBOR_DOMAIN } from '../../lib/connectors/shopify/demo-store'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { NORTHWIND_REFERENCES, ONLINE_STORE } from '../../lib/connectors/shopify/demo-store'
import { parseReference, type ReferenceKind } from '../../lib/agents/references'
import { parsePolicy, policyHash, summarizePolicy } from '../../lib/agents/policy'
import type { SeedCtx } from './index'
import type { Client } from 'pg'
import { createHash } from 'node:crypto'

export const MERCHANTS = [
  // Northwind's overselling rule is run by its "Stock Guardian" agent, so the store-wide rule stays off
  { key: 'northwind', name: 'Northwind Goods (synthetic)', email: 'owner@northwind-goods.example', domain: NORTHWIND_DOMAIN, tz: 'America/Chicago', state: northwindState, ruleOn: false },
  { key: 'harbor', name: 'Harbor Supply (synthetic)', email: 'owner@harbor-supply.example', domain: HARBOR_DOMAIN, tz: 'America/New_York', state: harborState, ruleOn: false },
]
const SCOPES = ['read_products', 'write_products', 'read_inventory', 'read_locations', 'read_publications', 'write_publications']

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
    await c.query(`update store_connections set currency = 'USD' where id = $1`, [conn])
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
  counts.merchant_agents = await seedNorthwindAgents(c)
}

const SEED_ACTOR = 'seed:demo owner'

async function seedReference(c: Client, org: string, conn: string, kind: ReferenceKind, name: string, csv: string): Promise<string> {
  const id = uuidFrom(`reference:northwind:${kind}`)
  const parsed = parseReference(kind, csv)
  await c.query(
    `insert into reference_sources (id, org_id, connection_id, kind, name, version, row_count, error_count, ambiguous_keys, file_sha256, columns, row_errors, uploaded_by)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12) on conflict (id) do nothing`,
    [id, org, conn, kind, name, parsed.rows.length, parsed.errors.length, parsed.ambiguousKeys, createHash('sha256').update(csv).digest('hex'), JSON.stringify(parsed.columns), JSON.stringify(parsed.errors), SEED_ACTOR])
  for (const r of parsed.rows) {
    await c.query(`insert into reference_rows (source_id, org_id, version, row_number, match_key, data) values ($1,$2,1,$3,$4,$5) on conflict do nothing`, [id, org, r.rowNumber, r.row.key, JSON.stringify(r.row)])
  }
  return id
}

/** Four Northwind agents, one per correction type. Their authorizations are marked as granted by the seeded demo owner. */
async function seedNorthwindAgents(c: Client): Promise<number> {
  const org = uuidFrom('merchant:northwind'), conn = uuidFrom('connection:northwind')
  const priceId = await seedReference(c, org, conn, 'price_list', 'Northwind price list', NORTHWIND_REFERENCES.price)
  const skuId = await seedReference(c, org, conn, 'sku_mapping', 'Northwind SKU mapping', NORTHWIND_REFERENCES.sku)
  const pubId = await seedReference(c, org, conn, 'publication_list', 'Online Store product list', NORTHWIND_REFERENCES.publication)
  const names = { [priceId]: 'Northwind price list', [skuId]: 'Northwind SKU mapping', [pubId]: 'Online Store product list' }
  // autonomous grants last at most one year; seeded demo grants end 360 days after seeding
  const until = new Date(Date.now() + 360 * 864e5).toISOString()
  const agents = [
    { key: 'stock-guardian', name: 'Stock Guardian', task: 'Every 6 hours, stop products from selling when they are out of stock, except anything tagged pre-order or backorder. Fix it automatically.',
      policy: { connectionId: conn, correctionTypes: ['oversell_policy'], productScope: { mode: 'all' }, rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } }, approvalMode: 'autonomous', validUntil: until, schedule: { kind: 'interval', everyHours: 6 } } },
    { key: 'price-keeper', name: 'Price Keeper', task: 'Check prices against my price list every day and ask me before changing anything.',
      policy: { connectionId: conn, correctionTypes: ['price'], productScope: { mode: 'all' }, rules: { price: { sourceId: priceId, fields: ['price'], maxChangePct: 20, skipVariantsOnSale: true } }, approvalMode: 'review', schedule: { kind: 'daily', hour: 6, minute: 0, timezone: 'America/Chicago' } } },
    { key: 'channel-keeper', name: 'Channel Keeper', task: 'Publish products on the Online Store when my product list says they should be live. Ask me first.',
      policy: { connectionId: conn, correctionTypes: ['publication'], productScope: { mode: 'all' }, rules: { publication: { publicationId: ONLINE_STORE, publicationName: 'Online Store', sourceId: pubId, allowUnpublish: false } }, approvalMode: 'review', schedule: { kind: 'manual' } } },
    { key: 'sku-filler', name: 'SKU Filler', task: 'Fill in missing SKUs from my SKU mapping automatically. Never change SKUs that are already set.',
      policy: { connectionId: conn, correctionTypes: ['sku'], productScope: { mode: 'all' }, rules: { sku: { sourceId: skuId, allowOverwrite: false } }, approvalMode: 'autonomous', validUntil: until, limits: { maxChangesPerRun: 10, maxChangesPerDay: 50 }, schedule: { kind: 'manual' } } },
  ]
  for (const a of agents) {
    const id = uuidFrom(`agent:northwind:${a.key}`), pid = uuidFrom(`agent-policy:northwind:${a.key}:1`)
    const exists = await c.query('select 1 from agents where id = $1', [id])
    if (exists.rowCount) continue
    const policy = parsePolicy(a.policy)
    const summary = summarizePolicy(policy, { storeName: 'Northwind Goods (synthetic)', sourceNames: names })
    await c.query(`insert into agents (id, org_id, connection_id, name, task_text, status, schedule, created_by) values ($1,$2,$3,$4,$5,'draft',$6,$7)`, [id, org, conn, a.name, a.task, JSON.stringify(policy.schedule), SEED_ACTOR])
    await c.query(`insert into agent_policies (id, org_id, agent_id, version, policy, policy_hash, summary, status, requires_grant, created_by, granted_by, granted_at) values ($1,$2,$3,1,$4,$5,$6,'active',true,$7,$7,now())`,
      [pid, org, id, JSON.stringify(policy), policyHash(policy), JSON.stringify(summary), SEED_ACTOR])
    const next = policy.schedule.kind === 'interval' ? new Date(Date.now() + policy.schedule.everyHours * 3600e3).toISOString() : null
    await c.query(`update agents set status = 'active', active_policy_id = $2, next_run_at = $3 where id = $1`, [id, pid, next])
  }
  return agents.length
}
