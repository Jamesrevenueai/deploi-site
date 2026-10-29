/**
 * Screenshot every agent-platform screen at 1440 and 390 into proof/screens/, with an index.html in order.
 * Run after scripts/seed-platform-demo.ts against a local production build (dev auth, synthetic store):
 *   node scripts/capture-screens.mjs http://localhost:3000 http://localhost:4173
 * Nothing here talks to a real store or inbox; the early-access form is filled but never submitted.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const [BASE = 'http://localhost:3000', SITE = 'http://localhost:4173'] = process.argv.slice(2)
const OUT = 'proof/screens'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const shots = [] // { n, group, name, caption }
let n = 0
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const page = await ctx.newPage()
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250) }

/** One screenshot pair. target: 'page' (full page), 'view' (viewport, for dialogs) or a CSS selector (element). */
async function shot(group, name, caption, target = 'page') {
  const id = `${String(++n).padStart(2, '0')}-${name}`
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h })
    await settle()
    const path = `${OUT}/${id}-${w}.png`
    // long captures would paint the sticky top bar and fixed phone tab bar mid-image; keep them in the page flow instead
    const tag = target === 'view' ? null : await page.addStyleTag({ content: '.bottombar,.topbar{position:static!important}' })
    if (target === 'page') { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path, fullPage: true }) }
    else if (target === 'view') await page.screenshot({ path })
    else { const el = page.locator(target).first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path }) }
    if (tag) await tag.evaluate(t => t.remove())
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  shots.push({ id, group, caption })
  console.log(id)
}
const go = async path => { await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(300) }
const section = (heading) => `section:has(> div h2:text-is("${heading}"))`

// sign in through the local dev login as the synthetic Northwind owner
await go('/login')
await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
const agents = (await (await page.request.get(`${BASE}/api/store/agents`)).json()).agents
const idOf = name => agents.find(a => a.name === name)?.id
for (const k of ['Stock Guardian', 'Stock Reviewer', 'Inventory Watcher', 'Supplier Chaser', 'Store Health Checker']) if (!idOf(k)) throw new Error(`seed missing: ${k}`)

// 1. Agents home
await go('/store/agents')
await shot('1. Agents home', 'agents-home', 'Agents home: the three templates, the running agents and the weekly summary preview.')

// 2. Each template's own screen
for (const [key, name] of [['inventory_watcher', 'Inventory Watcher'], ['supplier_chaser', 'Supplier Chaser'], ['store_health_checker', 'Store Health Checker']]) {
  await go(`/store/agents/new?template=${key}`)
  await shot('2. Templates', `template-${key}`, `${name} template: job description, tools, permission level (drafts only) and what you still supply.`)
  await go(`/store/agents/${idOf(name)}`)
  await shot('2. Templates', `template-${key}-agent`, `${name} created from the template: its own email address, the granted permission levels and the rules in plain English.`, section('Authorization'))
}

// 3. Custom agent, step by step
await go('/store/agents/new')
await page.fill('#agent-name', 'Apron Guard')
await shot('3. Create a custom agent', 'create-1-name', 'Step 1: name the agent.', 'view')
await page.fill('#agent-task', 'Every 6 hours, stop all products from selling when they are out of stock, except anything tagged pre-order. Ask me before changing anything.')
await shot('3. Create a custom agent', 'create-2-job', 'Step 2: the job in plain language.', 'view')
await page.getByRole('button', { name: 'Draft it' }).click()
await page.getByRole('heading', { name: 'What Deploi understood' }).waitFor()
await shot('3. Create a custom agent', 'create-3-understood', 'Step 3: what Deploi understood, what is still to choose, and what it cannot do. Nothing is granted.', section('What Deploi understood'))
await shot('3. Create a custom agent', 'create-4-tools', 'Step 4: connect tools. The store and what the agent may correct (each correction writes only its own field).', 'section#review')
await page.getByRole('button', { name: 'Review authorization' }).click()
await page.getByRole('heading', { name: 'Review the authorization' }).waitFor()
await shot('3. Create a custom agent', 'create-5-rules', 'Step 5: the translated rules, word for word, before anything is granted. New agents start at drafts only even though the task asked for approval.')
await page.getByRole('button', { name: 'Grant this authorization' }).click()
await page.getByText('Authorization granted.').waitFor()
await shot('3. Create a custom agent', 'create-6-approved', 'Step 6: approved. The exact version shown is now in force; overlap with other agents is called out.')
await page.getByRole('link', { name: 'Open agent' }).click()
await page.waitForURL(/\/store\/agents\/[0-9a-f-]{36}$/)
await settle()
const apronUrl = new URL(page.url()).pathname
await shot('3. Create a custom agent', 'create-7-first-screen', "The agent's first screen: status, permission level, schedule, authorization, nothing run yet.")
await page.getByRole('button', { name: 'Run now' }).click()
await page.waitForTimeout(1500)
await settle()
await shot('3. Create a custom agent', 'create-8-first-run', 'After the first run: the run is recorded with what it found. It drafts nothing new here because the Inventory Watcher already has the same fixes open (only one open change per record at a time).')

// 4. Permission screen at all three levels, then the new grant on widening
await page.getByRole('button', { name: 'Edit' }).click()
await page.getByRole('heading', { name: 'Edit agent' }).waitFor()
const mode = label => page.locator('label', { hasText: label }).locator('input[type=radio]').first()
const approvalBlock = 'section:has(h2:text-is("How changes are approved")), div:has(> div > h2:text-is("How changes are approved")), div:has(> h3:text-is("How changes are approved"))'
const approvalSel = await page.locator(approvalBlock).count() ? approvalBlock : 'fieldset:has(> legend:text-is("Approval mode"))'
await mode('Drafts only (default)').check()
await shot('4. Permissions', 'permission-1-drafts', 'Permission level 1 of 3: drafts only (the default). It never changes the store.', approvalSel)
await mode('After my approval').check()
await shot('4. Permissions', 'permission-2-approval', 'Permission level 2 of 3: after my approval. Nothing is written until you approve each change.', approvalSel)
await mode('Without asking, within limits').check()
await shot('4. Permissions', 'permission-3-autonomous', 'Permission level 3 of 3: without asking, within limits, with a required end date at most one year away.', approvalSel)
await mode('After my approval').check()
await page.getByRole('button', { name: 'Save changes' }).click()
await page.getByRole('button', { name: /Grant authorization version/ }).waitFor()
await shot('4. Permissions', 'permission-4-new-grant', 'Widening drafts only to after my approval: saved as a new version that waits for a new grant. The old version keeps running until then.')
await page.getByRole('button', { name: /Grant authorization version/ }).click()
await page.waitForTimeout(800)
await settle()
await shot('4. Permissions', 'permission-5-granted', 'The new version granted: version 2 is in force and the version history shows both.', section('Authorization versions'))

// 5. Agent detail: drafted changes, tasks, mailbox, work log
await go(`/store/agents/${idOf('Inventory Watcher')}`)
await shot('5. Agent detail', 'detail-watcher', 'Inventory Watcher, full page: authorization, drafted changes, tasks, mailbox and work log.')
await shot('5. Agent detail', 'detail-drafted-changes', 'Drafted changes: the exact change it would make, never made (drafts only).', 'section#waiting')
await go(`/store/agents/${idOf('Stock Guardian')}`)
await shot('5. Agent detail', 'detail-guardian', 'Stock Guardian, full page: acts without asking within its rules until its end date; verified results.')
await shot('5. Agent detail', 'detail-results', 'Results: only Verified means a fresh read of the store shows the change.', 'section#results')

// 6. Tasks: inside the rules, needs approval, refused
await shot('6. Tasks', 'tasks-three', 'Tasks: one inside the rules (ran, done), one that needs approval (outside the grant), one refused (Deploi cannot delete products).', 'section#tasks')
const items = page.locator('section#tasks li')
const count = await items.count()
for (let i = 0; i < Math.min(count, 3); i++) {
  const text = (await items.nth(i).innerText()).toLowerCase()
  const kind = text.includes('refused') ? 'refused' : text.includes('approval') ? 'needs-approval' : 'inside-rules'
  const el = `section#tasks li >> nth=${i}`
  await shot('6. Tasks', `task-${kind}`, kind === 'refused' ? 'Refused: what was asked and why nothing ran.' : kind === 'needs-approval' ? 'Needs approval: exactly what is outside the granted rules, and how to widen.' : 'Inside the rules: ran under the granted version, with its outcome.', el)
}

// 7. Work log
await shot('7. Work log', 'worklog', 'Work log: what happened, when, why, and which permission (authorization version) allowed it.', 'section#worklog')

// 8. Approval inbox
await go('/store/inbox')
await shot('8. Approval inbox', 'inbox', 'Approval inbox: store changes to approve, emails to approve, and drafts (reject only).')
await page.getByRole('button', { name: /^Approve (?!and send)/ }).first().click()
await page.getByText(/^Approved:/).waitFor()
await page.evaluate(() => window.scrollTo(0, 0))
await shot('8. Approval inbox', 'inbox-approved', 'After Approve: the change was re-read, written and confirmed by a fresh read (Verified).', 'view')
await page.getByRole('button', { name: /^Reject/ }).last().click()
await page.getByText(/^Rejected:/).waitFor()
await page.evaluate(() => window.scrollTo(0, 0))
await shot('8. Approval inbox', 'inbox-rejected', 'After Reject on the drafted alert email: it is closed and will not be sent.', 'view')

// 9. Agent email
await go(`/store/agents/${idOf('Supplier Chaser')}`)
await shot('9. Agent email', 'mail-mailbox', "Supplier Chaser mailbox: the sent restock request with the supplier's threaded reply, and a quarantined message the agent never sees.", 'section#mailbox')
await go(`/store/agents/${idOf('Store Health Checker')}`)
await shot('9. Agent email', 'mail-awaiting', 'Store Health Checker: its report waits for approval before it is sent.', 'section#mailbox')

// 10. Weekly summary
await go('/store/weekly')
await shot('10. Weekly summary', 'weekly', 'Weekly summary: the in-app version and the email exactly as rendered. Time saved is labelled as an estimate with its formula.')

// 11. Pause, revoke and delete
const reviewer = `/store/agents/${idOf('Stock Reviewer')}`
await go(reviewer)
await page.getByRole('button', { name: 'Pause' }).click()
await shot('11. Controls', 'control-pause-confirm', 'Pause: what pausing does, before you confirm.', 'view')
await page.getByRole('button', { name: 'Pause agent' }).click()
await page.getByRole('button', { name: 'Resume' }).waitFor()
await shot('11. Controls', 'control-paused', 'Paused: nothing runs or is written; waiting changes are cancelled; the authorization is kept.')
await page.getByRole('button', { name: 'Revoke' }).click()
await shot('11. Controls', 'control-revoke-confirm', 'Revoke: ends the authorization; the agent needs a new grant to do anything.', 'view')
await page.getByRole('button', { name: 'Revoke authorization' }).click()
await page.waitForTimeout(800)
await settle()
await shot('11. Controls', 'control-revoked', 'Revoked: the agent can do nothing until a new authorization is granted.')
await go(apronUrl)
await page.getByRole('button', { name: 'Delete' }).click()
await shot('11. Controls', 'control-delete-confirm', 'Delete: removes the agent; its history stays in the audit log.', 'view')
await page.getByRole('button', { name: 'Delete agent' }).click()
await page.waitForURL(u => u.pathname === '/store/agents')
await settle()
await shot('11. Controls', 'control-deleted', 'After delete: Apron Guard is gone from the list.')

// 12. Public website and early-access form (filled with synthetic data, never submitted)
await page.goto(SITE, { waitUntil: 'networkidle' })
await page.addStyleTag({ content: '.reveal{opacity:1!important;transform:none!important} header,nav,.nav{position:static!important}' })
await shot('12. Website', 'site-home', 'Public website: the full home page.')
await page.fill('#ea-name', 'Sam Rivera')
await page.fill('#ea-email', 'sam@example.com')
await page.fill('#ea-company', 'Example Goods')
await page.fill('#ea-url', 'https://example.com')
await shot('12. Website', 'site-early-access', 'Early-access form, filled with synthetic details (not submitted).', '#early-access')

// 13. Competitor & Trend Watcher (synthetic competitor stores on the reserved .example domain)
const G = '13. Competitor & Trend Watcher'
await go('/store/agents')
await shot(G, 'cw-agents-home', 'Agents home with the fourth template, and the seeded watcher showing its count of new competitor findings.')
await go('/store/agents/new?template=competitor_watcher')
await shot(G, 'cw-setup-empty', 'Setup: name, competitor stores, keywords, daily or weekly, alerts and an optional email summary, with what Deploi can and cannot read.')
const storesBox = page.getByLabel('Competitor store addresses, one per line')
await storesBox.fill('linen-and-loom.example\nhttps://harbor-home.example/collections/all\noak-and-ember.example\nplain-boutique.example\nprivate-label.example\nhttps://192.168.1.10')
await page.getByLabel('Also write me a summary after each check').check()
await page.getByLabel('Your email address (the only address it may write to)').fill('owner@northwind-goods.example')
await shot(G, 'cw-setup-validation', 'Addresses are validated as you type: any page of a store becomes its address, and an IP address is refused with the reason.', 'view')
await storesBox.fill('linen-and-loom.example\nhttps://harbor-home.example/collections/all\noak-and-ember.example\nplain-boutique.example\nprivate-label.example')
await page.getByRole('button', { name: 'Check these stores' }).click()
await page.getByText('Can be monitored').first().waitFor()
await shot(G, 'cw-setup-checked', 'Check these stores: three can be monitored, one is not supported (no public product feed), one asks not to be read (robots.txt) and will be skipped.')
await page.getByRole('button', { name: 'Review authorization' }).click()
await page.getByRole('heading', { name: 'Review the authorization' }).waitFor()
await shot(G, 'cw-rules', 'The rules in plain English: read only, public pages, robots.txt, one request per second, and never any claim about competitors\' sales.')
await page.getByRole('button', { name: 'Grant this authorization' }).click()
await page.getByText('Authorization granted.').waitFor()
await page.getByRole('link', { name: 'Open agent' }).click()
await page.waitForURL(/\/store\/agents\/[0-9a-f-]{36}$/)
await settle()
const cwUrl = new URL(page.url()).pathname
await page.getByRole('button', { name: 'Run now' }).click()
await page.waitForTimeout(1500)
await go(cwUrl)
await shot(G, 'cw-first-run-baseline', 'First run: a starting point per store. Nothing is reported as new; skipped stores say why.', 'section#competitors')

const trendId = (await (await page.request.get(`${BASE}/api/store/agents`)).json()).agents.find(a => a.name === 'Competitor & Trend Watcher' && a.id !== cwUrl.split('/').pop())?.id
await go(`/store/agents/${trendId}`)
await shot(G, 'cw-agent-detail', 'The seeded watcher after its second check: findings, stores, checks, tasks, mailbox and work log on one page.')
await shot(G, 'cw-findings', 'Findings: inferences (similar products on several stores, a possible opportunity) kept apart from changes observed on public pages.', 'section#competitors')
await shot(G, 'cw-opportunity', 'A possible opportunity with its evidence: each listing with store, page address, time seen and the public signals it rests on.', 'section#competitors div:has(> h3:text-is("Trends and possible opportunities (inference)"))')
await shot(G, 'cw-observed', 'Observed changes: new products, price changes, advertised discounts, sold out or back in stock, best-seller list moves and newly featured products.', 'section#competitors div:has(> h3:text-is("Changes observed on public pages"))')
await shot(G, 'cw-checks', 'Every check: when, how many requests, the exact pages read, and the stores skipped with the reason.', 'section#competitor-checks')
await shot(G, 'cw-tasks', 'Tasks: "Check my competitors now" runs; "Estimate my competitors\' sales and revenue" is refused because that is not public.', 'section#tasks')
await shot(G, 'cw-mailbox', 'The optional email summary, as a draft from the agent\'s own address: observed changes and inferences listed separately.', 'section#mailbox')
await shot(G, 'cw-worklog', 'Work log: each store checked or skipped, why, and the authorization that allowed reading public pages.', 'section#worklog')

await go(cwUrl)
await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
await page.getByRole('heading', { name: 'Edit agent' }).waitFor()
const cwBlock = ':has(> h3:has-text("Competitor stores"))'
await shot(G, 'cw-edit', 'Editing: the competitor stores, keywords, alerts and the smallest price change to report.', cwBlock)
const cwArea = page.locator(cwBlock).locator('textarea').first()
await cwArea.fill((await cwArea.inputValue()) + '\nnew-rival.example')
await page.getByRole('button', { name: 'Save changes' }).click()
await page.getByRole('button', { name: /Grant authorization version/ }).waitFor()
await shot(G, 'cw-widen-new-grant', 'Adding a store is a wider permission: saved as a new version that waits for your grant; the current stores keep being watched until then.')
await go('/store/weekly')
await shot(G, 'cw-weekly', 'Weekly summary: competitor changes seen and trends inferred, counted separately and kept out of the time-saved estimate.')

await browser.close()

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
let html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deploi screens</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:#fff;color:#111}h2{margin-top:40px;border-top:1px solid #ddd;padding-top:16px}figure{margin:0 0 32px}figcaption{margin-bottom:8px}.pair{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}.pair a:first-child{flex:3 1 480px}.pair a:last-child{flex:1 1 180px;max-width:260px}img{width:100%;border:1px solid #ccc}</style>
<h1>Deploi: every screen at 1440 and 390</h1><p>Synthetic Northwind Goods store and synthetic mail only. Local production build, ${new Date().toISOString().slice(0, 10)}. ${shots.length} screens, ${shots.length * 2} images.</p><ol>`
let group = ''
for (const s of shots) {
  if (s.group !== group) { html += `${group ? '</ol>' : '</ol>'}<h2>${esc(s.group)}</h2><ol start="${shots.indexOf(s) + 1}">`; group = s.group }
  html += `<li><figure><figcaption><b>${s.id}</b>: ${esc(s.caption)}</figcaption><div class="pair"><a href="${s.id}-1440.png"><img loading="lazy" src="${s.id}-1440.png" alt="${esc(s.caption)} (1440 wide)"></a><a href="${s.id}-390.png"><img loading="lazy" src="${s.id}-390.png" alt="${esc(s.caption)} (390 wide)"></a></div></figure></li>`
}
html += '</ol>'
writeFileSync(`${OUT}/index.html`, html)
console.log(`${shots.length} screens, ${shots.length * 2} images -> ${OUT}/index.html`)
