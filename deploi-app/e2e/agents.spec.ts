/**
 * Named agents end to end (synthetic Shopify stores, dev auth, seed applied):
 * an autonomous agent (Stock Guardian) runs and its results show Verified; a review-mode agent
 * (Price Keeper) runs and one waiting change, once approved, ends Verified; a new agent is created
 * through the wizard in review mode (a vague task cannot be submitted until scope is chosen) and
 * granted explicitly; another organization cannot open a Northwind agent; staff cannot run or grant.
 * The demo stores and their engine history are reset first so the spec is repeatable.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const STAFF = 'hello@getdeploi.com'
const WIZARD_AGENT = 'E2E Rope Watch'

type Agent = { id: string; name: string; status: string }

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json()) as T }
}

async function connectionId(page: Page): Promise<string> {
  const o = await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')
  expect(o.status).toBe(200)
  return o.json.connections[0].id
}

async function agents(page: Page): Promise<Agent[]> {
  const r = await api<{ agents: Agent[] }>(page, 'GET', '/api/store/agents')
  expect(r.status).toBe(200)
  return r.json.agents
}

/** Fresh catalogue and engine history; legacy store-wide oversell rule off so it never competes with Stock Guardian. */
async function resetNorthwind(page: Page) {
  const conn = await connectionId(page)
  expect((await api(page, 'POST', '/api/store/demo', { action: 'reset', connectionId: conn, clearHistory: true })).status).toBe(200)
  expect((await api(page, 'PUT', '/api/store/rules', { connectionId: conn, checkKey: 'shopify.oversell_policy', enabled: false })).status).toBe(200)
  for (const a of await agents(page)) {
    if (a.status === 'paused') expect((await api(page, 'POST', `/api/store/agents/${a.id}/resume`, {})).status).toBe(200)
  }
}

let stockGuardianId = ''
let priceKeeperId = ''

test('Stock Guardian (authorized to act within limits) runs and its results are Verified', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await resetNorthwind(page)
  const list = await agents(page)
  stockGuardianId = list.find(a => a.name === 'Stock Guardian')?.id ?? ''
  priceKeeperId = list.find(a => a.name === 'Price Keeper')?.id ?? ''
  expect(stockGuardianId).not.toBe('')
  expect(priceKeeperId).not.toBe('')

  await page.goto('/store/agents')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create agent' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Channel Keeper' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'SKU Filler' })).toBeVisible()
  await page.getByRole('link', { name: 'Stock Guardian' }).click()
  await expect(page).toHaveURL(new RegExp(`/store/agents/${stockGuardianId}$`))
  await expect(page.getByText('Without asking, within limits').first()).toBeVisible()

  await page.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByText('Run finished.')).toBeVisible({ timeout: 60_000 })
  const results = page.locator('#results')
  await expect(results.locator('.badge', { hasText: /^Verified$/ }).first()).toBeVisible()
  await expect(results.getByText('The agent, under its standing authorization').first()).toBeVisible()
  // nothing reported as done unless verified
  const d = await api<{ executions: { status: string }[] }>(page, 'GET', `/api/store/agents/${stockGuardianId}`)
  const verified = d.json.executions.filter(e => e.status === 'verified').length
  expect(verified).toBeGreaterThan(0)
  await expect(results.locator('.badge', { hasText: /^Verified$/ })).toHaveCount(verified)
})

test('Price Keeper (review each change) waits; approving one change ends Verified', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto(`/store/agents/${priceKeeperId}`)
  await expect(page.getByText('After my approval').first()).toBeVisible()
  await page.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByText('Run finished.')).toBeVisible({ timeout: 60_000 })

  const waiting = page.locator('#waiting')
  await expect(waiting.getByText('Awaiting approval').first()).toBeVisible()
  await expect(waiting.getByText(/this agent is in review mode/).first()).toBeVisible()
  // the oat throw: 79.00 -> 89.00 on the merchant's price list
  const approve = waiting.getByRole('button', { name: /Approve change for Linen Throw Blanket/ })
  await expect(approve).toBeVisible()
  await approve.click()
  await expect(page.getByText(/Verified: a fresh read shows the change/)).toBeVisible({ timeout: 60_000 })
  const results = page.locator('#results')
  await expect(results.locator('.badge', { hasText: /^Verified$/ }).first()).toBeVisible()
  await expect(results.getByText(/^You \(/).first()).toBeVisible()
})

test('the wizard refuses a vague task, then creates a review-mode agent that is granted only explicitly', async ({ page }) => {
  await signIn(page, HARBOR)
  const conn = await connectionId(page)
  expect((await api(page, 'POST', '/api/store/demo', { action: 'reset', connectionId: conn, clearHistory: true })).status).toBe(200)
  for (const a of (await agents(page)).filter(x => x.name === WIZARD_AGENT)) expect((await api(page, 'DELETE', `/api/store/agents/${a.id}`)).status).toBe(200)
  const before = (await agents(page)).length

  await page.goto('/store/agents')
  await page.getByRole('link', { name: 'Create agent' }).first().click()
  await expect(page).toHaveURL(/\/store\/agents\/new$/)
  await page.getByLabel('Agent name').fill(WIZARD_AGENT)
  await page.getByLabel('Task, in plain English').fill('Fix my store and restock anything that runs low.')
  await page.getByRole('button', { name: 'Draft it' }).click()
  await expect(page.getByText('This task is too general to authorize as written.')).toBeVisible()
  await expect(page.getByText("Deploi can't do this")).toBeVisible()
  await expect(page.getByText(/changing stock quantities/)).toBeVisible()

  // nothing chosen yet: the form will not submit
  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByText('Still to choose before this can be reviewed:')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review authorization' })).toBeDisabled()
  expect((await agents(page)).length).toBe(before)

  // choose explicitly: overselling + prices on all products, review each change
  await page.getByRole('checkbox', { name: /^Overselling configuration/ }).check()
  await page.getByRole('checkbox', { name: /^Prices/ }).check()
  await page.getByRole('radio', { name: 'All products in the store' }).check()
  await page.getByRole('radio', { name: /^After my approval/ }).check()

  // upload a price list inline; one bad row is reported, not guessed
  await page.getByText('Upload a price list (CSV)').click()
  await page.getByLabel('CSV file').setInputFiles({ name: 'harbor-prices.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,variant_id,price,compare_at_price,currency\nHS-RB-01,,25.00,,USD\nHS-CT-01,,not-a-price,,USD\n') })
  await page.getByRole('button', { name: 'Upload price list' }).click()
  await expect(page.getByText(/Uploaded "harbor-prices" as version|Same as the current version/)).toBeVisible()
  await expect(page.getByText(/Row 3: price must be a number/)).toBeVisible()
  await expect(page.getByLabel('Price list', { exact: true })).not.toHaveValue('')

  await expect(page.getByRole('button', { name: 'Review authorization' })).toBeEnabled()
  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByRole('heading', { name: 'Review the authorization' })).toBeVisible()
  await expect(page.getByText('This authorization allows')).toBeVisible()
  await expect(page.getByText(/you approve each exact change before it is made/).first()).toBeVisible()
  await expect(page.getByText('Never changes stock quantities.')).toBeVisible()

  // created as a draft: not active until granted
  const draft = (await agents(page)).find(a => a.name === WIZARD_AGENT)
  expect(draft?.status).toBe('draft')

  await page.getByRole('button', { name: 'Grant this authorization' }).click()
  await expect(page.getByText('Authorization granted.')).toBeVisible()
  await page.getByRole('link', { name: /Open agent/ }).click()
  await expect(page).toHaveURL(new RegExp(`/store/agents/${draft!.id}$`))
  await expect(page.locator('.badge', { hasText: /^Active$/ }).first()).toBeVisible()
  await expect(page.getByText('Current authorization · version 1')).toBeVisible()

  // review mode: a run proposes, nothing is written without approval
  await page.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByText('Run finished.')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#waiting').getByRole('button', { name: /Approve change for Rope Basket.*Continue selling when out of stock/ })).toBeVisible()
  await expect(page.locator('#results').getByText('No changes yet')).toBeVisible()

  // clean up through the UI (confirm dialog)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete agent' }).click()
  await expect(page).toHaveURL(/\/store\/agents$/)
  await expect(page.getByRole('link', { name: WIZARD_AGENT })).toHaveCount(0)
})

test('another organization cannot open a Northwind agent', async ({ page }) => {
  expect(stockGuardianId).not.toBe('')
  await signIn(page, HARBOR)
  await page.goto(`/store/agents/${stockGuardianId}`)
  await expect(page.getByText('Agent not found')).toBeVisible()
  expect((await api(page, 'GET', `/api/store/agents/${stockGuardianId}`)).status).toBe(404)
  expect((await api(page, 'POST', `/api/store/agents/${stockGuardianId}/run`, {})).status).toBe(404)
})

test('staff cannot run or grant a merchant agent', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const d = await api<{ policies: { id: string; policy_hash: string }[] }>(page, 'GET', `/api/store/agents/${priceKeeperId}`)
  const policy = d.json.policies[0]
  await signIn(page, STAFF)
  const run = await api<{ error: string }>(page, 'POST', `/api/store/agents/${priceKeeperId}/run`, {})
  expect(run.status).toBe(403)
  expect(run.json.error).toBe('forbidden')
  const grant = await api<{ error: string }>(page, 'POST', `/api/store/agents/${priceKeeperId}/grant`, { policyId: policy.id, policyHash: policy.policy_hash })
  expect(grant.status).toBe(403)
  const pause = await api(page, 'POST', `/api/store/agents/${priceKeeperId}/pause`, {})
  expect(pause.status).toBe(403)
})
