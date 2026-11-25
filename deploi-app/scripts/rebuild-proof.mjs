/**
 * Design-ref vs live screenshot pairs of the app at 1440 and 390, plus an axe-core run on every live screen.
 *   node scripts/rebuild-proof.mjs http://localhost:3000
 * Reference: design-ref/rendered/*.html (static renders of the approved designs). Live: a local production build
 * signed in through the dev login as the synthetic Northwind owner (no real store, inbox or phone).
 * Output: ../proof/rebuild-2026-11-23/app/<screen>-<ref|live>-<width>.png and axe.json.
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const ROOT = resolve(import.meta.dirname, '../..')
const OUT = `${ROOT}/proof/rebuild-2026-11-23/app`
mkdirSync(OUT, { recursive: true })
const axeSrc = readFileSync(`${ROOT}/node_modules/axe-core/axe.min.js`, 'utf8')
const ref = name => `file://${ROOT}/design-ref/rendered/${name}.html`

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const page = await ctx.newPage()
const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300) }

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
const setWorkspace = ws => page.request.post(`${BASE}/api/app/workspace`, { data: { workspace: ws }, headers: { origin: BASE } })
const cc = await (await page.request.get(`${BASE}/api/app/command-center?workspace=store`)).json()
const agentId = cc.team?.find(a => a.name === 'Inventory Watcher')?.id ?? cc.team?.[0]?.id
if (!agentId) throw new Error('no agent on the store side: seed the demo first')

const screens = [
  { name: 'command-center-store', ref: ref('app-command-center.store'), live: '/store', ws: 'store' },
  { name: 'command-center-office', ref: ref('app-command-center.office'), live: '/store', ws: 'office' },
  { name: 'agent-dashboard', ref: ref('app-agent-dashboard'), live: `/agents/${encodeURIComponent(agentId)}`, ws: 'store' },
  { name: 'agent-library', ref: ref('app-agent-library'), live: '/store/team', ws: 'store' },
]
const extraAxe = ['/store/plan', '/store/approvals', '/store/completed', '/store/my-team', '/store/integrations']
const axe = []

async function runAxe(label) {
  await page.addScriptTag({ content: axeSrc })
  const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => ({ id: x.id, impact: x.impact, nodes: x.nodes.length, targets: x.nodes.slice(0, 3).map(n => n.target.join(' ')) })))
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  axe.push({ page: label, violations: v, horizontalOverflowPx: overflow })
  console.log(label, 'axe', v.length, v.map(x => `${x.id}:${x.nodes}`).join(','), overflow > 1 ? `overflow ${overflow}px` : '')
}

for (const s of screens) {
  await setWorkspace(s.ws)
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto(s.ref, { waitUntil: 'load' }); await settle()
    await page.screenshot({ path: `${OUT}/${s.name}-ref-${w}.png`, fullPage: true })
    await page.goto(`${BASE}${s.live}`, { waitUntil: 'networkidle' }); await settle()
    await page.screenshot({ path: `${OUT}/${s.name}-live-${w}.png`, fullPage: true })
    await runAxe(`${s.name} ${w}`)
  }
}
await setWorkspace('store')
for (const p of extraAxe) for (const [w, h] of [[1440, 900], [390, 844]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' }); await settle()
  if (p === '/store/plan') await page.screenshot({ path: `${OUT}/plan-live-${w}.png`, fullPage: true })
  await runAxe(`${p} ${w}`)
}
writeFileSync(`${OUT}/axe.json`, JSON.stringify(axe, null, 2))
console.log('total violations', axe.reduce((a, r) => a + r.violations.length, 0))
await browser.close()
