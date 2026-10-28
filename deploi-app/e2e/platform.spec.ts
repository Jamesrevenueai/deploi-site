/**
 * Agent platform end to end (production build, dev auth, seeded synthetic stores):
 * templates on the Agents page with the weekly summary preview; creating a Supplier Chaser from its
 * template (own mailbox, drafts only, explicit grant); an Inventory Watcher that drafts changes it cannot
 * make; plain-language tasks with honest statuses; the work log; widening drafts -> approval needing a
 * new grant; another organization cannot see any of it. Saves a 1440/390 screenshot pair per view in proof/.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const SUPPLIER = 'orders@northwind-supplier.example'

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
/** Full-page screenshot at desktop and phone width. */
async function pair(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: `proof/${name}-1440.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: `proof/${name}-390.png`, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
}

let watcherId = ''

test('reset the demo store and remove earlier platform agents', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const conn = (await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')).json.connections[0].id
  expect((await api(page, 'POST', '/api/store/demo', { connectionId: conn, action: 'reset', clearHistory: true })).status).toBe(200)
  const list = await api<{ agents: { id: string; name: string }[] }>(page, 'GET', '/api/store/agents')
  for (const a of list.json.agents.filter(a => /Watcher|Chaser|Health/.test(a.name))) await api(page, 'DELETE', `/api/store/agents/${a.id}`)
})

test('Agents page: three templates at drafts only, and the weekly summary labelled as an estimate', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/agents')
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible()
  for (const n of ['Inventory Watcher', 'Supplier Chaser', 'Store Health Checker']) await expect(page.getByRole('heading', { name: n })).toBeVisible()
  await expect(page.getByText('Shopify: drafts only').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Weekly summary' })).toBeVisible()
  await expect(page.getByText('Estimate', { exact: true })).toBeVisible()
  await pair(page, 'platform-agents')
})

test('Supplier Chaser from its template: own address, drafts only, nothing granted until the merchant grants', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/agents/new?template=supplier_chaser')
  await expect(page.getByRole('heading', { name: 'Supplier Chaser' })).toBeVisible()
  await page.fill('#tpl-supplier', SUPPLIER)
  await page.click('button:has-text("Review authorization")')
  await expect(page.getByText('Its own address:')).toBeVisible()
  await expect(page.getByText(/@agents\.getdeploi\.test/).first()).toBeVisible()
  await expect(page.getByText(/may write drafts for you to review; it never sends/)).toBeVisible()
  await pair(page, 'platform-template-authorize')
  await page.click('button:has-text("Grant this authorization")')
  await expect(page.getByText('Authorization granted.')).toBeVisible()
})

test('Inventory Watcher: drafts the exact changes, cannot make them; tasks report honestly; the work log names the permission', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const conn = (await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')).json.connections[0].id
  const c = await api<{ agentId: string; policyId: string; policyHash: string }>(page, 'POST', '/api/store/agents', { template: 'inventory_watcher', connectionId: conn, notify: NORTHWIND })
  expect(c.status).toBe(200)
  watcherId = c.json.agentId
  expect((await api(page, 'POST', `/api/store/agents/${watcherId}/grant`, { policyId: c.json.policyId, policyHash: c.json.policyHash })).status).toBe(200)
  await page.goto(`/store/agents/${watcherId}`)
  // a task within the rules runs now and is not called "done" while drafts wait for the merchant
  await page.fill('#task-text', 'Check overselling on all products now')
  await page.click('button:has-text("Assign task")')
  await expect(page.locator('[aria-label="Tasks"] li').first()).toContainText('Waiting on you')
  // outside the rules: waits for a wider grant; unclear: refused
  await page.fill('#task-text', 'Fix prices automatically on all products')
  await page.click('button:has-text("Assign task")')
  await expect(page.locator('[aria-label="Tasks"] li').first()).toContainText('Needs your approval')
  await page.fill('#task-text', 'make it better')
  await page.click('button:has-text("Assign task")')
  await expect(page.locator('[aria-label="Tasks"] li').first()).toContainText('Refused')
  await expect(page.getByRole('heading', { name: 'Drafted changes (not made)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Approve change/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Work log' })).toBeVisible()
  await expect(page.locator('#worklog')).toContainText('Allowed by')
  await expect(page.locator('#worklog')).toContainText('none: nothing was allowed or done')
  await expect(page.locator('#mailbox')).toContainText('@agents.getdeploi.test')
  await pair(page, 'platform-agent-detail')
})

test('widening drafts -> after approval needs a new grant, shown with what it adds', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const d = await api<{ policies: { status: string; policy: Record<string, unknown> }[] }>(page, 'GET', `/api/store/agents/${watcherId}`)
  const active = d.json.policies.find(p => p.status === 'active')!.policy
  const r = await api<{ requiresGrant: boolean; expansion: string[] }>(page, 'PUT', `/api/store/agents/${watcherId}`, { policy: { ...active, approvalMode: 'review' } })
  expect(r.json.requiresGrant).toBe(true)
  expect(r.json.expansion).toContain('may now make changes you approve (was drafts only)')
  await page.goto(`/store/agents/${watcherId}`)
  await expect(page.getByText(/Version 2 is waiting for your grant/)).toBeVisible()
  await expect(page.getByText('may now make changes you approve (was drafts only)').first()).toBeVisible()
  await page.locator('#authorization').scrollIntoViewIfNeeded()
  await pair(page, 'platform-widen-needs-grant')
})

test('another organization cannot open the agent, its tasks or its work log', async ({ page }) => {
  await signIn(page, HARBOR)
  expect((await api(page, 'GET', `/api/store/agents/${watcherId}/worklog`)).status).toBe(404)
  expect((await api(page, 'POST', `/api/store/agents/${watcherId}/task`, { text: 'Check overselling' })).status).toBe(404)
  await page.goto(`/store/agents/${watcherId}`)
  await expect(page.getByText('Agent not found')).toBeVisible()
})
