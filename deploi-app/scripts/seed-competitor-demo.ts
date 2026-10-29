/**
 * Synthetic Competitor & Trend Watcher demo for screenshots and browser tests. Local database only (refuses
 * anything but a localhost DATABASE_URL); the "competitor stores" are in-process fakes, so nothing is
 * fetched from the internet. Runs the real pipeline over three simulated days: baseline, then launches,
 * price changes, a sale, an outage and a cross-store pattern; then hands one finding to a Supplier Chaser.
 *   npx tsx --env-file=.env.local scripts/seed-competitor-demo.ts
 *   npx tsx --env-file=.env.local scripts/seed-competitor-demo.ts --remove
 */
import { admin } from '../lib/db'
import { uuidFrom } from '../lib/ids'
import '../lib/connectors'
import { createAgent, grantPolicy } from '../lib/agents/lifecycle'
import { templatePolicy, templateByKey } from '../lib/agents/templates'
import { runAgent } from '../lib/agents/run'
import { COMPETITOR_SOURCES, shopifyPublicSource, type Fetcher } from '../lib/competitors/sources/shopify-public'
import { handOffInsight } from '../lib/competitors/handoff'
import type { Actor } from '../lib/engine/actor'
import type { Session } from '../lib/session'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) { console.error('refusing: DATABASE_URL is not a local database'); process.exit(1) }
process.env.AGENT_MAIL_DOMAIN ||= 'agents.getdeploi.test'
process.env.COMPETITOR_REQUEST_DELAY_MS = '0'

const ORG = uuidFrom('merchant:northwind'), CONN = uuidFrom('connection:northwind'), OWNER = 'owner@northwind-goods.example'
const NAME = 'Competitor Watch (demo)', CHASER = 'Supplier Chaser (competitor demo)'

type V = { id: number; title: string; price: string; compare_at_price: string | null; available: boolean }
type P = { id: number; handle: string; title: string; product_type: string; tags: string[]; published_at: string; variants: V[] }
const p = (id: number, title: string, price: string, type: string, published = '2026-06-01T00:00:00Z', v: Partial<V> = {}): P =>
  ({ id, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, product_type: type, tags: [type], published_at: published, variants: [{ id: id * 10, title: 'Default Title', price, compare_at_price: null, available: true, ...v }] })

type Store = { products: P[]; currency: string; down?: boolean; html?: boolean; best?: number[] }
const stores: Record<string, Store> = {
  'https://www.trailhead-goods.example.com': { currency: 'USD', best: [102, 101], products: [p(101, 'Canvas Weekender Bag', '120.00', 'bags'), p(102, 'Leather Card Wallet', '45.00', 'wallets'), p(103, 'Insulated Bottle', '32.00', 'bottles')] },
  'https://www.northbound-supply.example.com': { currency: 'USD', products: [p(201, 'Roll-top Backpack', '140.00', 'bags'), p(202, 'Tech Pouch', '28.00', 'organizers')] },
  'https://www.wayfare-co.example.co.uk': { currency: 'GBP', best: [301], products: [p(301, 'Linen Wash Bag', '24.00', 'bags'), p(302, 'Passport Holder', '19.00', 'wallets')] },
  'https://www.big-marketplace.example.com': { currency: 'USD', products: [], html: true },
}

const fake: Fetcher = async (u: string) => {
  const x = new URL(u), s = stores[x.origin]
  const res = (status: number, body: unknown, type = 'application/json') => ({ status, url: u, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type }, fetchedAt: new Date() })
  if (!s) return res(404, 'not found', 'text/html')
  if (x.pathname === '/robots.txt') return res(200, 'User-agent: *\nDisallow: /cart\nDisallow: /collections/*sort_by*\n', 'text/plain')
  if (s.down) return res(503, 'unavailable', 'text/html')
  if (s.html) return res(200, '<html>not a shop feed</html>', 'text/html')
  if (x.pathname === '/meta.json') return res(200, { name: x.hostname, currency: s.currency, published_products_count: s.products.length })
  if (x.pathname === '/products.json') { const page = Number(x.searchParams.get('page') ?? 1); return res(200, { products: s.products.slice((page - 1) * 250, page * 250) }) }
  if (x.pathname === '/collections/best-sellers/products.json' && s.best) return res(200, { products: s.best.map(id => s.products.find(q => q.id === id)).filter(Boolean) })
  return res(404, 'not found', 'text/html')
}

async function actor(): Promise<Actor> {
  const uid = (await admin(db => db.one<{ id: string }>('select id from profiles where lower(email) = $1', [OWNER])))!.id
  const session: Session = { uid, email: OWNER, role: 'client', agencyId: ORG, orgType: 'merchant' }
  return { kind: 'profile', session, orgId: ORG, label: `user:${OWNER}` }
}

async function remove() {
  const ids = await admin(db => db.query<{ id: string }>('select id from agents where org_id = $1 and name = any($2::text[])', [ORG, [NAME, CHASER]]))
  await admin(async db => {
    for (const { id } of ids) {
      await db.query('delete from email_messages where agent_id = $1', [id])
      await db.query("delete from email_accounts where agent_id = $1 and provider = 'deploi'", [id])
      await db.query('update agents set active_policy_id = null where id = $1', [id])
      await db.query('delete from agents where id = $1', [id])
    }
  })
  console.log(JSON.stringify({ removed: ids.length }))
}

async function main() {
  await remove()
  COMPETITOR_SOURCES.shopify_public = () => shopifyPublicSource(fake)
  const a = await actor()
  const t = templateByKey('competitor_watcher')!
  const raw = templatePolicy('competitor_watcher', { connectionId: CONN, timezone: 'America/New_York', notify: OWNER,
    competitor: { stores: Object.keys(stores).map(url => ({ url })), keywords: ['organizer', 'wash bag'], categories: ['bags'], region: 'United States', currency: 'USD' } })
  const c = await createAgent(a, { name: NAME, taskText: t.job, policy: raw, mailbox: true, templateKey: t.key })
  await grantPolicy(a, c.agentId, c.policyId, c.policyHash)
  const day = (n: number) => new Date(Date.now() - (3 - n) * 864e5)

  await runAgent(c.agentId, { trigger: 'manual', actor: a.label, now: day(0) })              // baseline
  const tg = stores['https://www.trailhead-goods.example.com'], nb = stores['https://www.northbound-supply.example.com'], wf = stores['https://www.wayfare-co.example.co.uk']
  tg.products.push(p(104, 'Travel Organizer Pro', '38.00', 'organizers', day(0.5).toISOString()))
  tg.products[0] = p(101, 'Canvas Weekender Bag', '96.00', 'bags', undefined, { compare_at_price: '120.00' })
  tg.best = [104, 102, 101]
  nb.down = true
  wf.products.push(p(303, 'Cable Organizer Roll', '16.00', 'organizers', day(0.6).toISOString()))
  await runAgent(c.agentId, { trigger: 'schedule', actor: 'system:scheduler', now: day(1) })
  nb.down = false
  nb.products.push(p(203, 'Packing Organizer Set', '42.00', 'organizers', day(1.5).toISOString()))
  nb.products[0] = p(201, 'Roll-top Backpack', '140.00', 'bags', undefined, { available: false })
  await runAgent(c.agentId, { trigger: 'schedule', actor: 'system:scheduler', now: day(2) })

  // a Supplier Chaser that sends only after approval, and one finding handed to it
  const sc = templatePolicy('supplier_chaser', { connectionId: CONN, timezone: 'America/New_York', supplierAddress: 'orders@northwind-supplier.example' }) as Record<string, unknown>
  const chaser = await createAgent(a, { name: CHASER, taskText: templateByKey('supplier_chaser')!.job, policy: { ...sc, email: { ...(sc.email as object), permission: 'send_approved' } }, mailbox: true, templateKey: 'supplier_chaser' })
  await grantPolicy(a, chaser.agentId, chaser.policyId, chaser.policyHash)
  const pattern = await admin(db => db.one<{ id: string }>(`select id from competitor_insights where agent_id = $1 and kind = 'cross_store_pattern' order by created_at desc limit 1`, [c.agentId]))
  const handed = pattern ? await handOffInsight(a, pattern.id, { supplierAgentId: chaser.agentId, note: 'We are considering a small first order for spring.' }) : null
  const counts = await admin(db => db.query<{ kind: string; basis: string; n: number }>(`select kind, basis, count(*)::int as n from competitor_insights where agent_id = $1 group by 1, 2 order by 1`, [c.agentId]))
  console.log(JSON.stringify({ agentId: c.agentId, chaserId: chaser.agentId, insights: counts, handoff: handed }, null, 1))
}

;(process.argv.includes('--remove') ? remove() : main()).then(() => process.exit(0), e => { console.error(e); process.exit(1) })
