/**
 * C8 proof on the synthetic Northwind store (local production build, DEMO_CONTROLS=true): the store has only the
 * read-only install scopes; an Inventory Watcher widened past drafts only reports the missing write scope, a write
 * is blocked, then the store "grants" write_products (demo control, standing in for Shopify's grant screen), the
 * sync picks it up and the notice disappears. Screenshots before/after into proof/shopify-e2e/.
 *   node scripts/scope-proof.mjs http://localhost:3000
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const OUT = 'proof/shopify-e2e'
const READ_ONLY = ['read_products', 'read_inventory', 'read_locations']
const record = { steps: [] }
const note = (step, data) => { record.steps.push({ step, ...data }); console.log(step, JSON.stringify(data)) }

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage()
const api = async (method, path, body) => { const r = await page.request.fetch(`${BASE}${path}`, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } }); let json = null; try { json = await r.json() } catch {} ; return { status: r.status(), json } }
const shot = async (name, sel) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(300); const path = `${OUT}/${name}.png`; if (sel) { const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path }) } else { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path, fullPage: true }) }; console.log('  shot', name) }

await page.goto(`${BASE}/login`)
await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
const conn = (await api('GET', '/api/store/overview')).json.connections[0]
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'reset', clearHistory: true })
for (const a of (await api('GET', '/api/store/agents')).json.agents.filter(a => /Watcher|Chaser|Health/.test(a.name))) await api('DELETE', `/api/store/agents/${a.id}`)
// the seeded Stock Guardian also corrects overselling on this store; remove the seeded agents so the watcher's grant is not refused as conflicting
for (const a of (await api('GET', '/api/store/agents')).json.agents) await api('DELETE', `/api/store/agents/${a.id}`)
// the store installed with read-only scopes, and Shopify answers the same
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'set_scopes', scopes: READ_ONLY })
note('c8.store-scopes-before-sync', { synthetic: true, shopifyAnswers: READ_ONLY })
const sync0 = await api('POST', '/api/store/scopes/sync', { connectionId: conn.id })
note('c8.sync-read-only', { status: sync0.status, granted: sync0.json.granted, changed: sync0.json.changed, requestable: sync0.json.requestable })

const iw = await api('POST', '/api/store/agents', { template: 'inventory_watcher', connectionId: conn.id, notify: 'test-mailbox@northwind-supplier.example' })
await api('POST', `/api/store/agents/${iw.json.agentId}/grant`, { policyId: iw.json.policyId, policyHash: iw.json.policyHash })
let d = (await api('GET', `/api/store/agents/${iw.json.agentId}`)).json
note('c8.drafts-only-needs-no-write-scope', { missing_scopes: d.policies.find(p => p.status === 'active').missing_scopes, storeScopes: d.storeScopes })
const active = d.policies.find(p => p.status === 'active').policy
const widen = await api('PUT', `/api/store/agents/${iw.json.agentId}`, { policy: { ...active, approvalMode: 'review' } })
note('c8.widen-reports-missing-scope', { requiresGrant: widen.json.requiresGrant, expansion: widen.json.expansion, missingScopes: widen.json.missingScopes })
await page.goto(`${BASE}/store/agents/${iw.json.agentId}`)
await shot('80-scope-notice-before-shopify-grant', '#authorization')
d = (await api('GET', `/api/store/agents/${iw.json.agentId}`)).json
const pending = d.policies.find(p => p.status === 'pending_grant')
const g2 = await api('POST', `/api/store/agents/${iw.json.agentId}/grant`, { policyId: pending.id, policyHash: pending.policy_hash })
note('c8.grant-v2', { status: g2.status, version: g2.json.version, error: g2.json.error ?? null, message: g2.json.message ?? null })
const run = await api('POST', `/api/store/agents/${iw.json.agentId}/run`, {})
note('c8.run-after-widening', { status: run.json.status, counts: run.json.counts })
d = (await api('GET', `/api/store/agents/${iw.json.agentId}`)).json
const wt = d.waiting[0]
const approve = await api('POST', `/api/store/proposals/${wt.id}/approve`, { changeHash: wt.change_hash })
note('c8.approve-blocked-without-write-scope', { status: approve.json.status, reason: approve.json.reason })
await page.goto(`${BASE}/store/agents/${iw.json.agentId}`)
await shot('81-write-blocked-missing-permission', '#results')
// the merchant grants it on Shopify's own screen (simulated); Deploi re-reads the granted list from Shopify
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'set_scopes', scopes: [...READ_ONLY, 'write_products'] })
const sync1 = await api('POST', '/api/store/scopes/sync', { connectionId: conn.id })
note('c8.sync-after-grant', { granted: sync1.json.granted, changed: sync1.json.changed })
d = (await api('GET', `/api/store/agents/${iw.json.agentId}`)).json
note('c8.notice-cleared', { missing_scopes: d.policies.find(p => p.status === 'active').missing_scopes })
await page.goto(`${BASE}/store/agents/${iw.json.agentId}`)
await shot('82-scope-notice-after-shopify-grant', '#authorization')
const retry = d.executions[0] ? await api('POST', `/api/store/executions/${d.executions[0].id}/retry`, {}) : null
note('c8.retry-after-grant', { status: retry?.json?.status, reason: retry?.json?.reason ?? null })
writeFileSync(`${OUT}/83-scope-record.json`, JSON.stringify(record, null, 2))
await browser.close()
