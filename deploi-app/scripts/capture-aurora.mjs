/**
 * Before/after screenshot pairs for the Aurora build, at 1440 and 390, into proof/aurora/.
 * "After" is this branch; "before" is the base branch (claude/retire-consulting) built in a second
 * checkout, the same route where it exists, or a "did not exist" card where it does not.
 *   node scripts/capture-aurora.mjs <after app> <before app> <after site> <before site>
 * Needs the seed applied, dev auth, DEMO_CONTROLS=true. The synthetic Northwind store is used; the
 * early-access form is never submitted; nothing leaves the machine.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const [AFTER = 'http://localhost:3000', BEFORE = 'http://localhost:3001', SITE = 'http://localhost:4173', SITE_BEFORE = 'http://localhost:4174'] = process.argv.slice(2)
const OUT = 'proof/aurora'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(`${OUT}/after`, { recursive: true }); mkdirSync(`${OUT}/before`, { recursive: true })
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const shots = []
let n = 0

async function session(base) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(`${base}/login`)
  await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
  const api = (method, path, body) => page.request.fetch(`${base}${path}`, { method, data: body, headers: { origin: base, 'content-type': 'application/json' } })
  return { ctx, page, api }
}
async function capture(page, base, path, file, { fullPage = true, before, missing = false } = {}) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h })
    const out = `${OUT}/${file}-${w}.png`
    if (missing) { await page.setContent(`<html><body style="margin:0;background:#06080F;color:#8A8A8A;font:16px Inter,system-ui;display:grid;place-items:center;height:${h}px"><div style="text-align:center;padding:24px"><div style="color:#fff;font-size:20px;margin-bottom:8px">${path}</div>did not exist on the base branch</div></body></html>`); await page.screenshot({ path: out }); continue }
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    if (before) await before(page)
    const tag = await page.addStyleTag({ content: '.bottombar,.topbar,.au-feedback{position:static!important}' }).catch(() => null)
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: out, fullPage })
    if (tag) await tag.evaluate(t => t.remove()).catch(() => null)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function pair(name, caption, { afterPath, beforePath, after, before, site = false, fullPage = true, beforeMissing = false, afterPrep, beforePrep }) {
  const id = `${String(++n).padStart(2, '0')}-${name}`
  await capture(after.page, site ? SITE : AFTER, afterPath, `after/${id}`, { fullPage, before: afterPrep })
  await capture(before.page, site ? SITE_BEFORE : BEFORE, beforePath ?? afterPath, `before/${id}`, { fullPage, before: beforePrep, missing: beforeMissing })
  shots.push({ id, caption, afterPath, beforePath: beforeMissing ? null : beforePath ?? afterPath })
  console.log(id)
}

const after = await session(AFTER)
const before = await session(BEFORE)
// state for the "after" screens: Pro trial, several agents on, a run each, a chat, one approval
const a = after.api
await a('POST', '/api/store/plan', { tier: 'pro' })
for (const k of ['listing_writer', 'order_tracker', 'ai_visibility', 'promo_manager', 'payout_fees_checker', 'weekly_insights']) await a('POST', `/api/store/library/${k}/switch`, { enabled: true })
await a('POST', '/api/store/library/supplier_chaser/settings', { patch: { supplierAddress: 'orders@northwind-supplier.example' } })
await a('POST', '/api/store/library/supplier_chaser/switch', { enabled: true })
await a('POST', '/api/store/library/inventory_watcher/switch', { enabled: true })
for (const k of ['listing_writer', 'order_tracker', 'ai_visibility', 'promo_manager', 'payout_fees_checker', 'weekly_insights', 'supplier_chaser', 'inventory_watcher']) await a('POST', `/api/store/library/${k}/run`, {})
await a('POST', '/api/store/library/order_tracker/instructions', { text: 'Warm tone. Treat anything more than two days late as stuck.' })
await a('POST', '/api/store/library/order_tracker/chat', { text: "what's waiting?", via: 'text' })
await a('POST', '/api/store/library/order_tracker/chat', { text: 'From now on, always offer a full refund if an order is more than five days late.', via: 'voice' })
const q = await (await a('GET', '/api/store/library/actions?agent=listing_writer&status=draft')).json()
const titleDraft = q.actions.find(x => x.action_type === 'draft_title') ?? q.actions[0]
if (titleDraft) await a('POST', `/api/store/library/actions/${titleDraft.id}/approve`, {})
await a('POST', '/api/store/library/listing_writer/permission', { level: 'act' })
await a('POST', '/api/store/library/listing_writer/grant', { actionType: 'draft_description', maxPerDay: 10 })
const team0 = await (await a('GET', '/api/store/library')).json()
for (const c of team0.buildYourOwn?.agents ?? []) await a('DELETE', `/api/store/library/custom/${c.id}`)
await a('POST', '/api/store/library/custom', { name: 'Late order nudger', job: 'Every morning, tell me which orders are late and draft a note to each customer.', permission: 'draft' })
await a('POST', '/api/store/onboarding', {})

// the pairs
await pair('team-dashboard', 'Team dashboard: twelve agents with characters and switches, locks with Upgrade, this week, usage meter, build your own.', { afterPath: '/store/team', before, after, beforeMissing: true })
await pair('team-dashboard-starter-locks', 'Team dashboard on the Starter tier: eight locked agents with the tier that unlocks them.', { afterPath: '/store/team', before, after, beforeMissing: true, afterPrep: async p => { await a('POST', '/api/store/plan', { tier: 'starter' }); await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(300) } })
await a('POST', '/api/store/plan', { tier: 'pro' })
for (const k of ['listing_writer', 'order_tracker', 'ai_visibility', 'promo_manager', 'payout_fees_checker', 'weekly_insights', 'supplier_chaser', 'inventory_watcher']) await a('POST', `/api/store/library/${k}/switch`, { enabled: true })
await a('POST', '/api/store/library/listing_writer/permission', { level: 'act' })
await a('POST', '/api/store/library/listing_writer/grant', { actionType: 'draft_description', maxPerDay: 10 })
await pair('agent-chat', 'Agent dashboard, chat tab: text and voice (the mic button), replies from the agent’s own log; a spoken instruction became a standing instruction.', { afterPath: '/store/team/order_tracker', before, after, beforeMissing: true })
await pair('agent-approvals', 'Agent dashboard, approval queue: each draft with its evidence, the exact change or message, and why it waits.', { afterPath: '/store/team/order_tracker', before, after, beforeMissing: true, afterPrep: async p => { await p.getByRole('tab', { name: /Approvals/ }).click(); await p.waitForTimeout(200) } })
await pair('agent-activity-log', 'Agent dashboard, activity log: every action with its status, the permission that allowed it, and the proof (fresh read after the write).', { afterPath: '/store/team/listing_writer', before, after, beforeMissing: true, afterPrep: async p => { await p.getByRole('tab', { name: 'Activity' }).click(); await p.waitForTimeout(200) } })
await pair('agent-instructions', 'Agent dashboard, standing instructions and settings.', { afterPath: '/store/team/order_tracker', before, after, beforeMissing: true, afterPrep: async p => { await p.getByRole('tab', { name: 'Instructions' }).click(); await p.waitForTimeout(200) } })
await pair('agent-auto-run', 'Agent dashboard, auto-run grants per action type: one granted with a daily cap; money actions marked approval-only.', { afterPath: '/store/team/listing_writer', before, after, beforeMissing: true, afterPrep: async p => { await p.getByRole('tab', { name: 'Auto-run' }).click(); await p.waitForTimeout(200) } })
await pair('agent-locked', 'A locked agent’s dashboard on Starter: the switch is replaced by the tier and an Upgrade link.', { afterPath: '/store/team/customer_care', before, after, beforeMissing: true, afterPrep: async p => { await a('POST', '/api/store/plan', { tier: 'starter' }); await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(300) } })
await a('POST', '/api/store/plan', { tier: 'pro' })
for (const k of ['listing_writer', 'order_tracker', 'ai_visibility', 'promo_manager', 'payout_fees_checker', 'weekly_insights', 'supplier_chaser', 'inventory_watcher']) await a('POST', `/api/store/library/${k}/switch`, { enabled: true })
await pair('plan', 'Plan and usage: the three tiers with their agents and allowance, prices as “coming soon”, this month’s usage.', { afterPath: '/store/plan', before, after, beforeMissing: true })
await pair('onboarding', 'Private-beta onboarding: connect, choose a plan to trial, switch on agents, done.', { afterPath: '/store/onboarding', before, after, beforeMissing: true })
await pair('feedback', 'The feedback button and its sheet (bottom right on every merchant screen).', { afterPath: '/store/team', before, after, beforeMissing: true, fullPage: false, afterPrep: async p => { await p.getByRole('button', { name: 'Feedback' }).click(); await p.waitForTimeout(200) } })
await pair('weekly-summary', 'Weekly summary: the team section with actions per agent and the time and money saved (estimates with formula).', { afterPath: '/store/weekly', before, after })
await pair('overview', 'Overview in the Aurora theme (same screen, before and after).', { afterPath: '/store', before, after })
await pair('agents-engine', 'The correction-engine agents page in the Aurora theme (same screen, before and after).', { afterPath: '/store/agents', before, after })
await pair('site-home', 'Website home: Aurora theme, the five-step “How it works”, the twelve-agent library.', { afterPath: '/', before, after, site: true })
await pair('site-agents', 'Website /agents: all twelve agents with character, plain-English description, example task and tier.', { afterPath: '/agents', before, after, site: true, beforeMissing: true })
await pair('site-pricing', 'Website /pricing: three tiers, allowance, overage, comparison table, prices “coming soon”.', { afterPath: '/pricing', before, after, site: true, beforeMissing: true })

const html = `<!doctype html><meta charset="utf-8"><title>Aurora build: before and after</title><style>body{font:14px Inter,system-ui;background:#06080F;color:#ccc;margin:24px}h1{color:#fff}figure{margin:0 0 40px}figcaption{color:#fff;margin-bottom:8px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row div{font-size:12px;color:#8A8A8A}img{width:100%;border:1px solid #222;border-radius:8px;background:#000}.phones{display:grid;grid-template-columns:repeat(2,220px);gap:12px;margin-top:8px}</style>
<h1>Aurora build: before (base branch) and after (this branch)</h1><p>Mockups were not attached to the session, so these pairs compare the base branch with this build; where a screen did not exist before, the left side says so.</p>
${shots.map(s => `<figure><figcaption>${s.id}: ${s.caption}</figcaption><div class="row"><div>before · ${s.beforePath ?? 'did not exist'}<img src="before/${s.id}-1440.png"></div><div>after · ${s.afterPath}<img src="after/${s.id}-1440.png"></div></div><div class="phones"><img src="before/${s.id}-390.png"><img src="after/${s.id}-390.png"></div></figure>`).join('')}`
writeFileSync(`${OUT}/index.html`, html)
writeFileSync(`${OUT}/pairs.json`, JSON.stringify(shots, null, 2))
await browser.close()
console.log(`${shots.length} pairs -> ${OUT}/index.html`)
