/**
 * Competitor & Trend Watcher in the browser (production build, dev auth). Needs the competitor demo seed
 * (scripts/seed-competitor-demo.ts), which ran the real pipeline over in-process fake stores. Covers: the
 * template in the gallery, setup validation and the authorization summary, the findings feed with
 * Observed / Inferred / Unavailable labels and evidence, source health, the comparison view with mixed
 * currencies, price history, the handoff state, and another organization being refused. Desktop and phone.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}
async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(path, { method, data: body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json()) as T }
}
async function pair(page: Page, name: string) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `${name} at ${w}px scrolls sideways`).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `proof/screens/competitor-${name}-${w}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function demoAgent(page: Page) {
  const r = await api<{ agents: { id: string; name: string }[] }>(page, 'GET', '/api/store/agents')
  const a = r.json.agents.find(x => x.name === 'Competitor Watch (demo)')
  expect(a, 'run scripts/seed-competitor-demo.ts first').toBeTruthy()
  return a!.id
}

test('the template is in the gallery and setup ends at an authorization that grants no store access', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/agents')
  await expect(page.getByRole('heading', { name: 'Competitor & Trend Watcher' })).toBeVisible()
  await expect(page.getByText('Public web pages: read only').first()).toBeVisible()
  await pair(page, 'gallery')
  await page.goto('/store/agents/new?template=competitor_watcher')
  await expect(page.getByText(/their sales, revenue, units or stock/)).toBeVisible()
  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByText('Add at least one store to watch.')).toBeVisible()
  await page.getByLabel('Web address').fill('localhost:8080')
  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByText('"localhost:8080" is not a web address.')).toBeVisible()
  await page.getByLabel('Web address').fill('shop.example.com')
  await page.getByLabel('Agent name').fill('E2E Competitor Watch')
  await page.getByLabel('Keywords (comma separated, optional)').fill('travel organizer')
  await pair(page, 'setup')
  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByText('Never reads, changes or writes anything in your own store.')).toBeVisible()
  await expect(page.getByText(/Never claims a competitor’s sales/)).toBeVisible()
  await expect(page.getByText(/obeys each store's robots.txt/)).toBeVisible()
  await pair(page, 'authorize')
  // clean up: the created draft agent
  const r = await api<{ agents: { id: string; name: string }[] }>(page, 'GET', '/api/store/agents')
  for (const a of r.json.agents.filter(x => x.name === 'E2E Competitor Watch')) expect((await api(page, 'DELETE', `/api/store/agents/${a.id}`)).status).toBe(200)
})

test('findings say what was observed, what is inferred and what was unavailable, with evidence and limits', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const id = await demoAgent(page)
  await page.goto(`/store/agents/${id}`)
  await expect(page.getByRole('heading', { name: 'Watched stores' })).toBeVisible()
  // source health: the marketplace is not a Shopify storefront; it says so
  await expect(page.getByText('Not supported').first()).toBeVisible()
  await expect(page.getByText(/does not publish a Shopify product feed/).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wider market trends' })).toBeVisible()
  // labels
  await expect(page.getByText('Inferred').first()).toBeVisible()
  await expect(page.getByText('Observed').first()).toBeVisible()
  await expect(page.getByText('Unavailable').first()).toBeVisible()
  await expect(page.getByText(/stores you follow added organizer products/).first()).toBeVisible()
  // evidence and limitations open in place
  await page.getByRole('button', { name: /Evidence and limitations/ }).first().click()
  await expect(page.getByText(/Sales, revenue and units are not visible on public pages/).first()).toBeVisible()
  // the handoff is recorded, and says nothing was sent
  await expect(page.getByText(/as a message waiting for your approval \(not sent\)/)).toBeVisible()
  // no store-change sections for a watcher
  await expect(page.getByRole('heading', { name: 'Waiting for your approval' })).toHaveCount(0)
  await pair(page, 'detail')
})

test('comparison never mixes currencies, and price history shows observed states', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const id = await demoAgent(page)
  await page.goto(`/store/agents/${id}#compare`)
  await expect(page.getByRole('heading', { name: 'Compare products' })).toBeVisible()
  await expect(page.getByText(/price in different currencies \(.*GBP.*\)|price in different currencies \(.*USD.*\)/)).toBeVisible()
  await page.getByLabel('Word in title, type or tag').fill('weekender')
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByRole('link', { name: 'Canvas Weekender Bag' })).toBeVisible()
  await page.getByRole('button', { name: 'History' }).first().click()
  await expect(page.getByRole('heading', { name: 'Price and availability history' })).toBeVisible()
  await expect(page.getByText('96.00 USD').first()).toBeVisible()
  await expect(page.getByText('120.00 USD').first()).toBeVisible()
  await pair(page, 'history')
})

test('another organization cannot see the watcher, its findings or products', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const id = await demoAgent(page)
  await signIn(page, HARBOR)
  expect((await api(page, 'GET', `/api/store/agents/${id}/competitors`)).status).toBe(404)
  expect((await api(page, 'GET', `/api/store/agents/${id}/competitors/products`)).status).toBe(404)
  await page.goto(`/store/agents/${id}`)
  await expect(page.getByText('Agent not found')).toBeVisible()
})
