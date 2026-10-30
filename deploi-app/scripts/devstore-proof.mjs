/**
 * Proof run for the three starter templates and the weekly summary against the SYNTHETIC Northwind store
 * (local production build, dev auth, EMAIL_LIVE_SENDS=off, DEMO_CONTROLS=true). Nothing here talks to a real
 * Shopify store or a real mailbox. Writes before/after screenshots and a JSON record into proof/shopify-e2e/.
 *   node scripts/devstore-proof.mjs http://localhost:3000
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const OUT = 'proof/shopify-e2e'
const OWNER = 'owner@northwind-goods.example'
const TEST_MAILBOX = 'test-mailbox@northwind-supplier.example'   // synthetic test mailbox; never a real address
const OTHER = 'someone-else@elsewhere.example'
mkdirSync(OUT, { recursive: true })
const record = { startedAt: new Date().toISOString(), base: BASE, steps: [] }
const note = (step, data) => { record.steps.push({ step, ...data }); console.log(step, JSON.stringify(data)) }

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const page = await ctx.newPage()
const api = async (method, path, body) => {
  const r = await page.request.fetch(`${BASE}${path}`, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  let json = null; try { json = await r.json() } catch {}
  return { status: r.status(), json }
}
const go = async p => { await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(300) }
const shot = async (name, target = 'page') => {
  const path = `${OUT}/${name}.png`
  const tag = await page.addStyleTag({ content: '.bottombar,.topbar{position:static!important}' })
  if (target === 'page') { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path, fullPage: true }) }
  else { const el = page.locator(target).first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path }) }
  await tag.evaluate(t => t.remove())
  console.log('  shot', path)
}

// sign in as the synthetic store owner
await go('/login')
await page.selectOption('select[name=email]', OWNER)
await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
const overview = (await api('GET', '/api/store/overview')).json
const conn = overview.connections[0]
note('0.signin', { store: conn.external_id ?? conn.externalId ?? conn.display_name, synthetic: conn.is_synthetic ?? conn.isSynthetic, connectionId: conn.id })
await go('/store')
await shot('10-app-overview-synthetic-store')

// fresh catalogue and no earlier template agents
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'reset', clearHistory: true, clearEmail: true })
for (const a of (await api('GET', '/api/store/agents')).json.agents.filter(a => /Watcher|Chaser|Health/.test(a.name))) await api('DELETE', `/api/store/agents/${a.id}`)
await go('/store/agents')
await shot('11-agents-home-three-templates')

const V = n => `gid://shopify/ProductVariant/${n}`

// ---------- 3a. Inventory Watcher ----------
await go('/store/agents/new?template=inventory_watcher')
await shot('20-inventory-watcher-template')
const iw = await api('POST', '/api/store/agents', { template: 'inventory_watcher', connectionId: conn.id, notify: TEST_MAILBOX })
note('3a.create', { status: iw.status, agentId: iw.json.agentId })
const iwId = iw.json.agentId
const g1 = await api('POST', `/api/store/agents/${iwId}/grant`, { policyId: iw.json.policyId, policyHash: iw.json.policyHash })
note('3a.grant-v1-drafts-only', { status: g1.status })
await go(`/store/agents/${iwId}`)
await shot('21-inventory-watcher-granted-drafts-only-before-run')
// make the "Walnut Serving Board" (12 available, Continue selling on) drop to low stock -> oversold at -2
const before = await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'external_change', variantId: V(2004), available: -2, inventoryPolicy: 'CONTINUE' })
note('3a.drop-stock', { status: before.status, variant: 'Walnut Serving Board NW-WSB-01', available: -2, policy: 'CONTINUE' })
const run1 = await api('POST', `/api/store/agents/${iwId}/run`, {})
note('3a.run', { status: run1.status, result: run1.json })
await go(`/store/agents/${iwId}`)
await shot('22-inventory-watcher-after-run-drafted-changes')
const msgs1 = (await api('GET', `/api/store/email/messages?agent=${iwId}`)).json?.messages ?? []
note('3a.alert-emails', { count: msgs1.length, messages: msgs1.map(m => ({ task: m.task_key, to: m.to_addresses, status: m.status, subject: m.subject })) })
// an action outside the grant: blocked, asks for a new grant
const t1 = await api('POST', `/api/store/agents/${iwId}/task`, { text: 'Fix prices automatically on all products' })
note('3a.out-of-grant-task', { status: t1.status, taskStatus: t1.json?.task?.status, reason: t1.json?.task?.status_reason })
const t2 = await api('POST', `/api/store/agents/${iwId}/task`, { text: 'Delete the products that have not sold this year' })
note('3a.impossible-task', { status: t2.status, taskStatus: t2.json?.task?.status, reason: t2.json?.task?.status_reason })
await go(`/store/agents/${iwId}`)
await shot('23-inventory-watcher-blocked-task-needs-approval', '[aria-label="Tasks"]')
// widening drafts -> after approval requires a new grant (version 2)
const d = (await api('GET', `/api/store/agents/${iwId}`)).json
const active = d.policies.find(p => p.status === 'active').policy
const widen = await api('PUT', `/api/store/agents/${iwId}`, { policy: { ...active, approvalMode: 'review' } })
note('3a.widen-needs-grant', { status: widen.status, requiresGrant: widen.json.requiresGrant, expansion: widen.json.expansion })
await go(`/store/agents/${iwId}`)
await shot('24-inventory-watcher-version2-waiting-for-grant', '#authorization')
const approveButtons = await page.getByRole('button', { name: /^Approve change/ }).count()
note('3a.no-approve-button-at-drafts-only', { approveButtons })

// ---------- 3b. Supplier Chaser ----------
await go('/store/agents/new?template=supplier_chaser')
await page.fill('#tpl-supplier', TEST_MAILBOX)
await page.click('button:has-text("Review authorization")')
await page.getByText('Its own address:').waitFor()
await shot('30-supplier-chaser-review-authorization')
await page.click('button:has-text("Grant this authorization")')
await page.getByText('Authorization granted.').waitFor()
const sc = (await api('GET', '/api/store/agents')).json.agents.find(a => a.name === 'Supplier Chaser')
const scId = sc.id
note('3b.create+grant', { agentId: scId, supplier: TEST_MAILBOX })
// widen email to "send messages you approve one by one" so a send can be attempted (held by EMAIL_LIVE_SENDS=off)
const sd = (await api('GET', `/api/store/agents/${scId}`)).json
const scActive = sd.policies.find(p => p.status === 'active')
const w2 = await api('PUT', `/api/store/agents/${scId}`, { policy: { ...scActive.policy, email: { ...scActive.policy.email, permission: 'send_approved' } } })
note('3b.widen-email', { status: w2.status, requiresGrant: w2.json.requiresGrant, expansion: w2.json.expansion })
const pending = (await api('GET', `/api/store/agents/${scId}`)).json.policies.find(p => p.status === 'pending' || p.status === 'proposed' || p.version === 2)
if (pending) note('3b.grant-v2', { status: (await api('POST', `/api/store/agents/${scId}/grant`, { policyId: pending.id, policyHash: pending.policy_hash ?? pending.policyHash })).status, version: pending.version })
// make two products low (<= 2 available) so the chaser has something to chase
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'external_change', variantId: V(2012), available: 1 })
await api('POST', '/api/store/demo', { connectionId: conn.id, action: 'external_change', variantId: V(2002), available: 2 })
const run2 = await api('POST', `/api/store/agents/${scId}/run`, {})
note('3b.run', { status: run2.status, result: run2.json })
const msgs2 = (await api('GET', `/api/store/email/messages?agent=${scId}`)).json?.messages ?? []
note('3b.chase-email', { count: msgs2.length, messages: msgs2.map(m => ({ id: m.id, task: m.task_key, from: m.from_address, to: m.to_addresses, status: m.status, subject: m.subject })) })
await go(`/store/agents/${scId}`)
await shot('31-supplier-chaser-restock-request-awaiting-approval')
const reorder = msgs2.find(m => m.task_key === 'supplier_reorder')
if (reorder) {
  const card = page.locator('#email-waiting li').filter({ hasText: TEST_MAILBOX })
  const btn = card.getByRole('button', { name: `Approve and send to ${TEST_MAILBOX}` })
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(2500) }
  const after = (await api('GET', `/api/store/email/messages?agent=${scId}`)).json.messages.find(m => m.id === reorder.id)
  note('3b.approve-held-sends-off', { status: after?.status, reason: after?.status_reason ?? after?.hold_reason ?? null })
  await go(`/store/agents/${scId}`)
  await shot('32-supplier-chaser-approved-held-live-sends-off')
}
// cannot email any other address
const t3 = await api('POST', `/api/store/agents/${scId}/task`, { text: `Email ${OTHER} and ask them to confirm restock of our low products` })
note('3b.other-address-blocked', { status: t3.status, taskStatus: t3.json?.task?.status, reason: t3.json?.task?.status_reason, outside: t3.json?.task?.outside_rules })
await go(`/store/agents/${scId}`)
await shot('33-supplier-chaser-other-address-blocked', '[aria-label="Tasks"]')

// ---------- 3c. Store Health Checker ----------
const execBefore = (await api('GET', `/api/store/activity`)).json
const auditBefore = (await api('GET', `/api/store/audit?limit=200`)).json
const stateBefore = JSON.stringify((await api('GET', `/api/store/issues?connection=${conn.id}`)).json)
const sh = await api('POST', '/api/store/agents', { template: 'store_health_checker', connectionId: conn.id, notify: TEST_MAILBOX })
const shId = sh.json.agentId
await api('POST', `/api/store/agents/${shId}/grant`, { policyId: sh.json.policyId, policyHash: sh.json.policyHash })
const run3 = await api('POST', `/api/store/agents/${shId}/run`, {})
note('3c.run', { status: run3.status, result: run3.json })
await go(`/store/agents/${shId}`)
await shot('40-store-health-checker-after-run')
const msgs3 = (await api('GET', `/api/store/email/messages?agent=${shId}`)).json?.messages ?? []
const details3 = []
for (const m of msgs3) { const dm = (await api('GET', `/api/store/email/messages/${m.id}`)).json; details3.push({ task: m.task_key, from: m.from_address, to: m.to_addresses, status: m.status, subject: dm?.content?.subject ?? m.subject, body: (dm?.content?.bodyText ?? '').slice(0, 1500) }) }
note('3c.report', { count: msgs3.length, messages: details3 })
const worklog = (await api('GET', `/api/store/agents/${shId}/worklog`)).json
note('3c.worklog', { entries: (worklog.log ?? []).slice(0, 12) })
record.healthChecker = { execBefore, auditBefore, stateBefore }

// ---------- 3d. Weekly summary ----------
await go('/store/agents')
await shot('50-weekly-summary-on-agents-home', 'section:has(h2:text-is("Weekly summary"))').catch(() => shot('50-weekly-summary-on-agents-home'))
const weekly = (await api('GET', '/api/store/weekly')).json
note('3d.weekly-preview', { weekly })

record.agents = { inventoryWatcher: iwId, supplierChaser: scId, storeHealthChecker: shId }
record.finishedAt = new Date().toISOString()
writeFileSync(`${OUT}/record.json`, JSON.stringify(record, null, 2))
await browser.close()
