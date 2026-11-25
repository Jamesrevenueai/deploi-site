/**
 * Seed every commerce-pack scenario into the synthetic store of one organization, for a scenario run.
 * Development database only: refuses anything but a localhost DATABASE_URL. Never touches a real store: it only
 * writes to synthetic_store_state, and only for a connection flagged is_synthetic (one is created when the
 * organization has none). Nothing is sent: the synthetic store's outbox keeps every email an agent writes.
 *
 *   npx tsx --env-file=.env.local scripts/seed-commerce-scenarios.ts --org <org uuid> [--scenarios a,b,c] [--sweep]
 *     --scenarios  a comma list from COMMERCE_SCENARIOS (default: all of them)
 *     --sweep      also run one sweep of the twelve agents and print what each did
 *     --reset      also clear the organization's commerce-pack work log first
 */
import { randomUUID } from 'node:crypto'
import { admin } from '../lib/db'
import { setSyntheticState, commerceQuietState, seedCommerceScenario, seedCommerceCrew, COMMERCE_SCENARIOS, COMMERCE_DOMAIN, type CommerceScenario } from '../lib/connectors/shopify/synthetic'
import { COMMERCE_AGENTS } from '../lib/commerce/pack/agents'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url) || process.env.VERCEL_ENV === 'production' || process.env.DEPLOI_ENV === 'production') {
  console.error('refusing: DATABASE_URL is not a local development database')
  process.exit(1)
}

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? '' : null }
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main() {
  const org = arg('org')
  if (!org || !/^[0-9a-f-]{36}$/i.test(org)) throw new Error('pass --org <organization uuid>')
  const wanted = (arg('scenarios') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const unknown = wanted.filter(s => !(COMMERCE_SCENARIOS as readonly string[]).includes(s))
  if (unknown.length) throw new Error(`unknown scenarios: ${unknown.join(', ')} (known: ${COMMERCE_SCENARIOS.join(', ')})`)
  // the two "unknown order" and "thin facts" variants are edge cases; the default run seeds every scenario
  const scenarios = (wanted.length ? wanted : [...COMMERCE_SCENARIOS]) as CommerceScenario[]

  const exists = await admin(db => db.one<{ id: string }>('select id from agencies where id = $1', [org]))
  if (!exists) throw new Error(`no organization ${org}`)
  const real = await admin(db => db.one<{ id: string }>(`select id from store_connections where org_id = $1 and status = 'active' and not is_synthetic`, [org]))
  if (real) throw new Error('this organization has an active real store connection; seed a synthetic organization instead')
  let conn = await admin(db => db.one<{ id: string }>(`select id from store_connections where org_id = $1 and platform = 'shopify' and is_synthetic order by created_at limit 1`, [org]))
  if (!conn) {
    const id = randomUUID()
    await admin(db => db.query(
      `insert into store_connections (id, org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, installed_at)
       values ($1,$2,'shopify',$3,'Fernhill Home (synthetic)','active',$4,'2026-10',true,'Europe/London',now())`,
      [id, org, `${org.slice(0, 8)}-${COMMERCE_DOMAIN}`, ['read_products', 'write_products', 'read_inventory', 'read_locations']]))
    conn = { id }
    console.log(`created synthetic Shopify connection ${id}`)
  }
  await admin(db => db.query(`update store_connections set status = 'active', status_reason = null where id = $1`, [conn!.id]))
  if (flag('reset')) {
    const keys = COMMERCE_AGENTS.map(a => a.key)
    const n = await admin(db => db.query(`delete from library_actions where org_id = $1 and agent_key = any($2) and permission_basis like 'commerce_pack:%' returning id`, [org, keys]))
    console.log(`cleared ${n.length} commerce work log rows`)
  }
  const now = new Date()
  const state = commerceQuietState(now)
  for (const s of scenarios) seedCommerceScenario(state, s, now)
  await setSyntheticState(conn.id, state)
  // the store's packer is a real member of the organization's crew roster (crew_members), not a synthetic-only id
  const packer = await seedCommerceCrew(org)
  console.log(`packer on the crew roster: ${packer}`)
  console.log(`seeded ${scenarios.length} scenarios into synthetic connection ${conn.id}: ${scenarios.join(', ')}`)

  if (flag('sweep')) {
    const { sweepCommerce } = await import('../lib/commerce/pack')
    const results = await sweepCommerce(org)
    for (const r of results) {
      console.log(`${r.agentKey}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
      for (const o of r.outcomes) console.log(`  ${o.kind} ${o.status}${o.latencyMs !== null ? ` ${o.latencyMs}ms` : ''}${o.error ? ` - ${o.error}` : ''}`)
    }
  }
}

main().then(() => process.exit(0), e => { console.error((e as Error).message); process.exit(1) })
