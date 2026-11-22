/**
 * Launch build (2026-11-07) proof pass: every new screen of the standalone app in a real browser, at 1440 and 390.
 * Production build, dev auth, DEMO_CONTROLS=true, synthetic providers only (AI_PROVIDER=off). For each business type
 * the owner picks, the matching agent packs show; each pack page lists its agents with an honest status.
 * Screenshots: proof/launch/<name>-1440.png and -390.png.
 * The approved redesign (2026-11-06): the Command center on the Store and the Office side (switched from the
 * sidebar, by mouse and by keyboard), and the Needs-you empty state of a brand-new account; no horizontal page
 * scroll at 390. Screenshots: proof/redesign/after-local/<name>-1440.png and -390.png.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const OWNER = 'owner@northwind-goods.example'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}
async function api(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(path, { method, data: body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: await res.json().catch(() => ({})) as Record<string, unknown> }
}
async function pair(page: Page, name: string, dir = 'proof/launch') {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => null)
    await page.waitForTimeout(250)
    // no horizontal page scroll at phone width
    if (w === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} overflows at 390`).toBeLessThanOrEqual(391)
    await page.screenshot({ path: `${dir}/${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function visit(page: Page, path: string, name: string, heading?: RegExp) {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  const res = await page.goto(path)
  expect(res?.status(), path).toBeLessThan(400)
  await expect(page.getByRole('heading', { level: 1, ...(heading ? { name: heading } : {}) }).first()).toBeVisible()
  await pair(page, name)
  expect(errors, `${path} page errors`).toEqual([])
}

const TYPES: { type: string; packs: string[] }[] = [
  { type: 'store', packs: ['commerce', 'office'] },
  { type: 'home_services', packs: ['home_services'] },
  { type: 'leasing_agent', packs: ['leasing'] },
  { type: 'real_estate_agent', packs: ['real_estate'] },
  { type: 'property_manager', packs: ['property_management'] },
]

test('every business type shows its packs; each pack page renders its agents', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, OWNER)
  for (const t of TYPES) {
    const r = await api(page, 'POST', '/api/store/packs', { op: 'business-type', businessType: t.type, ...(t.type === 'home_services' ? { trade: 'hvac' } : {}) })
    expect(r.status, `business type ${t.type}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(200)
    await visit(page, '/store/packs', `packs-${t.type}`)
    for (const p of t.packs) {
      await visit(page, `/store/packs/${p}`, `pack-${p}`)
      // every agent card says what it does and how far it is (synthetic only / working), never an empty page
      await expect(page.locator('main')).toContainText(/test data only|working|ready/i)
    }
  }
  // back to a store for the other specs
  expect((await api(page, 'POST', '/api/store/packs', { op: 'business-type', businessType: 'store' })).status).toBe(200)
})

test('settings (agent modes, owner updates), connections, setup and approvals', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, OWNER)
  await visit(page, '/store/settings', 'settings')
  await expect(page.locator('main')).toContainText(/ask me first|do it and tell me/i)
  await visit(page, '/store/integrations', 'integrations')
  for (const name of ['Salesforce', 'Pipedrive', 'Zoho', 'Buildium', 'QuickBooks']) await expect(page.locator('main'), name).toContainText(name)
  await visit(page, '/store/setup', 'setup')
  await visit(page, '/store/approvals', 'approvals')
})

const AFTER = 'proof/redesign/after-local'
/** At 390 the page never scrolls sideways; the team table scrolls inside its own box instead. */
async function noSideScroll(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }))
  expect(m.doc, `${name}: page width at 390`).toBeLessThanOrEqual(m.vw)
  expect(m.body, `${name}: body width at 390`).toBeLessThanOrEqual(m.vw)
  const table = page.getByTestId('team-table')
  if (await table.count()) {
    const t = await table.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right }))
    expect(t.right, `${name}: the table box stays inside the screen`).toBeLessThanOrEqual(390)
    expect(t.scroll, `${name}: the table scrolls inside its box`).toBeGreaterThan(t.client)
  }
  // the sidebar sits above the content on a phone
  const side = await page.locator('aside.app-sidebar').boundingBox(), main = await page.locator('main#main').boundingBox()
  expect(side && main && side.y + side.height <= main.y + 1, `${name}: sidebar above content`).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
}

test('redesign: the Command center on both sides, switched from the sidebar; no horizontal scroll at 390', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await signIn(page, OWNER)
  expect((await api(page, 'POST', '/api/app/workspace', { workspace: 'store' })).status).toBe(200)
  await page.goto('/store')
  const cc = page.getByTestId('command-center')
  await expect(cc).toHaveAttribute('data-workspace', 'store')
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)\. Your team is on it\.$/ })).toBeVisible()
  await expect(page.getByTestId('hero')).toContainText(/agents? running/)
  await expect(page.getByRole('searchbox', { name: 'Search agents, orders, proof' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Command center/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('usage')).toContainText('Actions this month')
  // the store's own numbers: as many rows as the feed
  const store = (await api(page, 'GET', '/api/app/command-center?workspace=store')).json as { team: unknown[]; needsYou: unknown[] }
  await expect(page.getByTestId('team-row')).toHaveCount(store.team.length)
  await expect(page.getByTestId('needs-you-card')).toHaveCount(store.needsYou.length)
  await noSideScroll(page, 'command-center-store')
  await pair(page, 'command-center-store', AFTER)

  // Office, by mouse: the whole app follows
  await page.getByRole('radio', { name: 'Office' }).click()
  await expect(cc).toHaveAttribute('data-workspace', 'office')
  expect(((await api(page, 'GET', '/api/app/workspace')).json as { workspace: string }).workspace).toBe('office')
  const office = (await api(page, 'GET', '/api/app/command-center?workspace=office')).json as { team: unknown[] }
  await expect(page.getByTestId('team-row')).toHaveCount(office.team.length)
  await noSideScroll(page, 'command-center-office')
  await pair(page, 'command-center-office', AFTER)

  // back to Store by keyboard
  await page.getByRole('radio', { name: 'Office' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(cc).toHaveAttribute('data-workspace', 'store')
  await expect(page.getByRole('radio', { name: 'Store' })).toBeFocused()

  // the team conversation opens and closes from the keyboard
  await page.getByRole('button', { name: 'Talk to your team' }).click()
  const chat = page.getByRole('dialog', { name: 'Talk to your team' })
  await expect(chat).toBeVisible()
  await chat.getByRole('textbox', { name: 'Message' }).fill('status')
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(chat.locator('.app-chat-msg.agent').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(chat).toHaveCount(0)
  expect(errors).toEqual([])
})

test('redesign: a brand-new account sees honest empty states (Needs you, the Command center)', async ({ page }) => {
  test.setTimeout(120_000)
  const run = Date.now().toString(36)
  await page.request.post('/logout')
  await page.goto('/login')
  await page.getByLabel('New account email').fill(`redesign.${run}@e2e-redesign.example`)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(u => u.pathname === '/start')
  await page.getByLabel('Business name').fill(`Fresh Redesign ${run}`)
  await page.getByRole('button', { name: 'Create my business' }).click()
  await page.waitForURL(u => u.pathname === '/store/setup')

  await page.goto('/store/approvals')
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible()
  await expect(page.getByTestId('needs-you-empty')).toContainText('Nothing needs you right now')
  await expect(page.locator('[data-approval]')).toHaveCount(0)
  await noSideScroll(page, 'needs-you-empty')
  await pair(page, 'needs-you-empty', AFTER)

  await page.goto('/store')
  await expect(page.getByTestId('needs-empty')).toContainText('Nothing needs you right now')
  await expect(page.getByTestId('done-empty')).toContainText('No finished work yet')
  await expect(page.getByTestId('team-empty')).toContainText('No agents yet')
  for (const id of ['needs-you-card', 'done-row', 'team-row']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(page.getByTestId('usage')).toContainText(/0 (used|of)/)
  await noSideScroll(page, 'command-center-empty')
})
