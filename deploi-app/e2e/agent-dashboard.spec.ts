/**
 * The agent dashboard (/agents/:id) in a real browser against a local production build: dev auth,
 * DEMO_CONTROLS=true, ALLOW_DEV_LOGIN=true, AI_PROVIDER=off, a local database migrated and seeded (the
 * synthetic Northwind store). Run as e.g.:
 *   set -a; . ./.env.test; set +a; DATABASE_URL=<local db> DEMO_CONTROLS=true ALLOW_DEV_LOGIN=true AI_PROVIDER=off npm run build
 *   ... npx next start -p 3300 &   E2E_BASE_URL=http://localhost:3300 PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/agent-dashboard.spec.ts
 * Covers: the seeded store's Inventory Watcher with real data; changing its autonomy level, reloading, still
 * chosen; adding, editing and deleting a standing instruction; no horizontal page scroll at 390; a 404 for an
 * unknown agent. Screenshots: proof/redesign/after-local/agent-dashboard-1440.png and -390.png.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const OWNER = 'owner@northwind-goods.example'
const ID = 'store:inventory_watcher'
const PATH = `/agents/${encodeURIComponent(ID)}`

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
const errors: string[] = []
async function open(page: Page) {
  const res = await page.goto(PATH)
  expect(res?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory Watcher' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', e => errors.push(e.message))
  await signIn(page, OWNER)
})
test.afterAll(() => { expect(errors, 'page errors').toEqual([]) })

test('the seeded Inventory Watcher, with real work: a scan and a run first', async ({ page }) => {
  test.setTimeout(180_000)
  // give it something real to show: a fresh scan of the synthetic store and a manual run of the agent
  const scan = await api(page, 'POST', '/api/store/scan', {})
  expect(scan.status, JSON.stringify(scan.json).slice(0, 200)).toBeLessThan(500)
  const on = await api(page, 'POST', '/api/store/library/inventory_watcher/switch', { enabled: true })
  expect(on.status, JSON.stringify(on.json).slice(0, 200)).toBe(200)
  const run = await api(page, 'POST', '/api/store/library/inventory_watcher/run', {})
  expect(run.status, JSON.stringify(run.json).slice(0, 200)).toBe(200)
  const d = await api(page, 'GET', `/api/app/agents/${encodeURIComponent(ID)}`)
  expect(d.status).toBe(200)

  await open(page)
  await expect(page.locator('a[data-back]')).toHaveAttribute('href', '/store')
  await expect(page.getByRole('list', { name: 'This agent in numbers' }).getByRole('listitem')).toHaveCount(4)
  await expect(page.getByText('Anything that spends money always asks first, on every level.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'What it can touch' }).getByRole('listitem').first()).toBeVisible()
  await expect(page.getByLabel('Message Inventory Watcher')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Speak to Inventory Watcher' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  const work = (d.json.dashboard as { work: unknown[] }).work
  if (work.length) await expect(page.getByRole('region', { name: /^Work done, table/ }).getByRole('row')).toHaveCount(work.length + 1)
  else await expect(page.getByText('No work yet — finished work shows here with its proof')).toBeVisible()
})

test('autonomy: change it, reload, still chosen (and persisted on the server)', async ({ page }) => {
  await open(page)
  const group = page.getByRole('group', { name: 'How much can it do alone?' })
  const ask = group.getByRole('radio', { name: /Ask first/ })
  const full = group.getByRole('radio', { name: /Fully autonomous/ })
  const target = (await ask.isChecked()) ? full : ask
  const label = (await ask.isChecked()) ? 'autonomous' : 'ask_first'
  // keyboard-operable: focus the group's checked radio and move with the arrow keys is the browser's own; a click here
  await target.check()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('group', { name: 'How much can it do alone?' }).getByRole('radio', { name: label === 'ask_first' ? /Ask first/ : /Fully autonomous/ })).toBeChecked()
  const d = await api(page, 'GET', `/api/app/agents/${encodeURIComponent(ID)}`)
  expect((d.json.dashboard as { agent: { autonomy: string; autonomyChosen: boolean } }).agent).toMatchObject({ autonomy: label, autonomyChosen: true })
  // and with the keyboard: arrow to the next option, it saves too
  const checked = page.getByRole('group', { name: 'How much can it do alone?' }).getByRole('radio', { checked: true })
  await checked.focus()
  await page.keyboard.press(label === 'ask_first' ? 'ArrowDown' : 'ArrowUp')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'How much can it do alone?' }).getByRole('radio', { name: /Act, then tell me/ })).toBeChecked()
  await page.reload()
  await expect(page.getByRole('group', { name: 'How much can it do alone?' }).getByRole('radio', { name: /Act, then tell me/ })).toBeChecked()
})

test('standing instructions: add, edit and delete', async ({ page }) => {
  // start from none of this test's own
  const list = await api(page, 'GET', `/api/app/agents/${encodeURIComponent(ID)}/instructions`)
  for (const i of (list.json.instructions as { id: string; text: string }[]).filter(i => i.text.startsWith('E2E:'))) await api(page, 'DELETE', `/api/app/agents/${encodeURIComponent(ID)}/instructions/${i.id}`)
  await open(page)
  await page.getByRole('button', { name: 'Add a standing instruction for Inventory Watcher' }).click()
  await page.getByLabel('New instruction for Inventory Watcher').fill('E2E: never reorder candles')
  await page.getByRole('button', { name: 'Save instruction' }).click()
  await expect(page.getByRole('button', { name: 'Edit instruction: E2E: never reorder candles' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Edit instruction: E2E: never reorder candles' }).click()
  await page.getByRole('textbox', { name: /^Edit instruction/ }).fill('E2E: never reorder candles in July')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit instruction: E2E: never reorder candles in July' })).toBeVisible()
  await page.reload()
  await expect(page.getByText('E2E: never reorder candles in July')).toBeVisible()
  await page.getByRole('button', { name: 'Delete instruction: E2E: never reorder candles in July' }).click()
  await expect(page.getByText('E2E: never reorder candles in July')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('E2E: never reorder candles in July')).toHaveCount(0)
})

test('an unknown agent is a 404', async ({ page }) => {
  for (const p of [`/agents/${encodeURIComponent('pack:nobody_here')}`, '/agents/garbage']) {
    const res = await page.goto(p)
    expect(res?.status(), p).toBe(404)
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Agent not found' })).toBeVisible()
})

test('no horizontal page scroll at 390; the work table scrolls inside its box; screenshots at 1440 and 390', async ({ page }) => {
  await open(page)
  // a short chat exchange so the screenshot shows real bubbles from real data
  await page.getByLabel('Message Inventory Watcher').fill('status')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('[role=log]').getByText(/^Inventory Watcher: /).last()).toBeVisible()
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => null)
    await page.waitForTimeout(300)
    if (w === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'page overflows at 390').toBeLessThanOrEqual(390)
      const table = page.getByRole('region', { name: /^Work done, table/ })
      if (await table.count()) {
        const box = await table.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
        expect(box.scroll).toBeGreaterThan(box.client)
      }
      for (const name of ['Speak to Inventory Watcher', 'Send message', 'Pause agent']) {
        const b = await page.getByRole('button', { name }).first().boundingBox()
        expect(b && b.height >= 44 && b.width >= 44, `${name} is at least 44px`).toBe(true)
      }
    }
    await page.screenshot({ path: `proof/redesign/after-local/agent-dashboard-${tag}.png`, fullPage: true })
  }
})
