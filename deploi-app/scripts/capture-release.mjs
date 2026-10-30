/**
 * Before/after screenshot pairs for the production release, at 1440 and 390 px, into proof/release/.
 * "Before" is what production serves today (live getdeploi.com and app.getdeploi.com, public pages only,
 * read with GET requests). "After" is the release candidate running locally on synthetic data.
 * Screens that production does not have yet (roster, agent dashboard, approvals) get a card saying so.
 *   node scripts/capture-release.mjs <after app> <after site>
 * Needs the seed applied, dev auth and DEMO_CONTROLS=true. Nothing is submitted to production.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const [AFTER = 'http://localhost:3000', SITE = 'http://localhost:4173'] = process.argv.slice(2)
const LIVE_SITE = 'https://getdeploi.com', LIVE_APP = 'https://app.getdeploi.com'
const OUT = 'proof/release'
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
async function capture(page, url, file, { fullPage = true, prep, missing } = {}) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h })
    const out = `${OUT}/${file}-${w}.png`
    if (missing) { await page.setContent(`<html><body style="margin:0;background:#05060D;color:#8A8A8A;font:16px Inter,system-ui;display:grid;place-items:center;height:${h}px"><div style="text-align:center;padding:24px"><div style="color:#fff;font-size:20px;margin-bottom:8px">${missing}</div>not in production today</div></body></html>`); await page.screenshot({ path: out }); continue }
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    if (prep) await prep(page)
    const tag = await page.addStyleTag({ content: '.bottombar,.topbar,.au-feedback{position:static!important}' }).catch(() => null)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: out, fullPage })
    if (tag) await tag.evaluate(t => t.remove()).catch(() => null)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function pair(name, caption, { after, beforeUrl, beforeMissing, prep, fullPage = true }) {
  const id = `${String(++n).padStart(2, '0')}-${name}`
  await capture(afterPage(after), after, `after/${id}`, { fullPage, prep })
  await capture(livePage, beforeUrl, `before/${id}`, { fullPage, missing: beforeMissing })
  shots.push({ id, caption, after, before: beforeMissing ? null : beforeUrl })
  console.log(id)
}

const after = await session(AFTER)
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

const liveCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const livePage = await liveCtx.newPage()
const anonCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const anonPage = await anonCtx.newPage()
const afterPage = url => (url.startsWith(SITE) || url.endsWith('/login') ? anonPage : after.page)

await pair('site-home', 'Website home.', { after: `${SITE}/`, beforeUrl: `${LIVE_SITE}/` })
await pair('site-agents', 'Website agents page, from the shared library config.', { after: `${SITE}/agents`, beforeUrl: `${LIVE_SITE}/agents` })
await pair('site-pricing', 'Website pricing page: three tiers, prices coming soon.', { after: `${SITE}/pricing`, beforeUrl: `${LIVE_SITE}/pricing` })
await pair('app-landing', 'App landing (sign-in).', { after: `${AFTER}/login`, beforeUrl: `${LIVE_APP}/login` })
await pair('roster', 'Agent roster: twelve drawn bots, switches, locks with Upgrade.', { after: `${AFTER}/store/team`, beforeMissing: 'Agent roster' })
await pair('agent-dashboard', 'One agent dashboard: status, chat with voice, standing instructions.', { after: `${AFTER}/store/team/order_tracker`, beforeMissing: 'Agent dashboard' })
await pair('approvals', 'Approvals: each draft with its evidence and the exact change.', { after: `${AFTER}/store/team/order_tracker`, beforeMissing: 'Approvals', prep: async p => { await p.getByRole('tab', { name: /Approvals/ }).click(); await p.waitForTimeout(250) } })

const html = `<!doctype html><meta charset="utf-8"><title>Release: before and after</title><style>body{font:14px Inter,system-ui;background:#05060D;color:#ccc;margin:24px}h1{color:#fff}figure{margin:0 0 40px}figcaption{color:#fff;margin-bottom:8px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row div{font-size:12px;color:#8A8A8A}img{width:100%;border:1px solid #222;border-radius:8px;background:#000}.phones{display:grid;grid-template-columns:repeat(2,220px);gap:12px;margin-top:8px}</style>
<h1>Release: before (production today) and after (release candidate)</h1>
${shots.map(s => `<figure><figcaption>${s.id}: ${s.caption}</figcaption><div class="row"><div>before · ${s.before ?? 'not in production'}<img src="before/${s.id}-1440.png"></div><div>after · ${s.after}<img src="after/${s.id}-1440.png"></div></div><div class="phones"><img src="before/${s.id}-390.png"><img src="after/${s.id}-390.png"></div></figure>`).join('')}`
writeFileSync(`${OUT}/index.html`, html)
writeFileSync(`${OUT}/pairs.json`, JSON.stringify(shots, null, 2))
await browser.close()
console.log(`${shots.length} pairs -> ${OUT}/index.html`)
