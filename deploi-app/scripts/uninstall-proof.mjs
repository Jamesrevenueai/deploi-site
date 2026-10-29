/**
 * 4b proof against the local production server + local DB (synthetic Northwind store):
 * a credential is stored for the store, agents are active; a signed app/uninstalled arrives; agents go
 * active -> paused and credentials 1 -> 0. Screenshots of the Agents page before and after.
 *   node scripts/uninstall-proof.mjs http://localhost:3000 <SHOPIFY_API_SECRET of the running server>
 */
import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [BASE = 'http://localhost:3000', SECRET = 'devstore-test-secret-0123456789'] = process.argv.slice(2)
const SHOP = 'northwind-goods-demo.myshopify.com'
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/deploi_dev'
const OUT = 'proof/shopify-e2e'
const q = sql => execFileSync('psql', [DB, '-Atc', sql]).toString().trim()
const state = () => ({
  connection: q(`select status || ' uninstalled_at=' || coalesce(uninstalled_at::text, '-') from store_connections where external_id = '${SHOP}'`),
  credentials: Number(q(`select count(*) from store_credentials c join store_connections s on s.id = c.connection_id where s.external_id = '${SHOP}'`)),
  agents: q(`select string_agg(name || ':' || status, ', ' order by name) from agents a join store_connections s on s.id = a.connection_id where s.external_id = '${SHOP}' and a.status <> 'deleted'`),
  activeAgents: Number(q(`select count(*) from agents a join store_connections s on s.id = a.connection_id where s.external_id = '${SHOP}' and a.status = 'active'`)),
  pausedAgents: Number(q(`select count(*) from agents a join store_connections s on s.id = a.connection_id where s.external_id = '${SHOP}' and a.status = 'paused'`)),
})

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage()
await page.goto(`${BASE}/login`)
await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
const shot = async name => { await page.goto(`${BASE}/store/agents`, { waitUntil: 'networkidle' }); await page.waitForTimeout(300); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); console.log('  shot', name) }

const record = { shop: SHOP }
record.before = state()
console.log('before', JSON.stringify(record.before))
await shot('70-uninstall-before-agents-active')

const raw = JSON.stringify({ id: 1, domain: SHOP })
const res = await fetch(`${BASE}/api/shopify/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': SHOP, 'x-shopify-webhook-id': `wh-uninstall-proof-${Date.now()}`, 'x-shopify-api-version': '2026-10', 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64') }, body: raw })
record.webhook = { status: res.status, body: await res.text() }
console.log('signed app/uninstalled ->', record.webhook.status, record.webhook.body)
record.after = state()
record.audit = q(`select event || ' ' || coalesce(detail::text, '') from engine_audit where connection_id = (select id from store_connections where external_id = '${SHOP}') and (event = 'connection.uninstalled' or event = 'agent.paused') order by at desc limit 6`).split('\n')
console.log('after', JSON.stringify(record.after))
console.log('audit', JSON.stringify(record.audit))
await shot('71-uninstall-after-agents-paused')
writeFileSync(`${OUT}/72-uninstall-record.json`, JSON.stringify(record, null, 2))
await browser.close()
