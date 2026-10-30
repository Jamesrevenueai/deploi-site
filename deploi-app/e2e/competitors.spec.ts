/**
 * Competitor & Trend Watcher end to end (production build, dev auth, synthetic competitor stores on the
 * reserved .example domain; nothing real is contacted): the setup screen validates addresses and checks
 * them; the agent's authorization says read only; the first run records starting points, the second
 * reports observed changes and an inference; another organization and staff cannot read the findings.
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
async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json()) as T }
}

let agentId = ''

test('setup: addresses are validated, checked, and explained', async ({ page }) => {
  await signIn(page, NORTHWIND)
  for (const a of (await api<{ agents: { id: string; name: string }[] }>(page, 'GET', '/api/store/agents')).json.agents.filter(a => a.name.startsWith('E2E Trend')))
    await api(page, 'DELETE', `/api/store/agents/${a.id}`)
  await page.goto('/store/agents/new?template=competitor_watcher')
  await expect(page.getByRole('heading', { name: 'What Deploi can read' })).toBeVisible()
  await expect(page.getByText('What it can never tell you')).toBeVisible()
  await page.getByLabel('Competitor store addresses, one per line').fill('harbor-home.example/collections/all\nhttps://10.0.0.8\nprivate-label.example\nplain-boutique.example')
  await expect(page.getByText("Not valid: use the store's domain name, not an IP address")).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review authorization' })).toBeDisabled()
  await page.getByLabel('Competitor store addresses, one per line').fill('harbor-home.example/collections/all\nprivate-label.example\nplain-boutique.example')
  await page.getByRole('button', { name: 'Check these stores' }).click()
  await expect(page.getByText('Can be monitored')).toBeVisible()
  await expect(page.getByText('Asks not to be read (robots.txt)')).toBeVisible()
  await expect(page.getByText('Not supported', { exact: true })).toBeVisible()
})

test('create from the template: read only, nothing before the grant, starting point first, then changes', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const conn = (await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')).json.connections[0].id
  const c = await api<{ agentId: string; policyId: string; policyHash: string; summary: { grants: string[]; never: string[] }; mailbox: unknown }>(page, 'POST', '/api/store/agents',
    { template: 'competitor_watcher', connectionId: conn, name: 'E2E Trend Watcher', competitor: { stores: ['linen-and-loom.example', 'harbor-home.example', 'oak-and-ember.example', 'private-label.example'], cadence: 'weekly' } })
  expect(c.status).toBe(200)
  agentId = c.json.agentId
  expect(c.json.mailbox).toBeNull() // no email summary asked for: no address, no email permission
  expect(c.json.summary.grants.join(' ')).toMatch(/Competitor monitoring \(read only\)/)
  expect(c.json.summary.never.join(' ')).toMatch(/Never claims to know a competitor's sales/)
  expect((await api(page, 'POST', `/api/store/agents/${agentId}/run`, {})).status).toBe(409)
  expect((await api(page, 'POST', `/api/store/agents/${agentId}/grant`, { policyId: c.json.policyId, policyHash: c.json.policyHash })).status).toBe(200)

  const r1 = await api<{ status: string; counts: { competitors: { storesChecked: number; storesSkipped: number; baselines: number } } }>(page, 'POST', `/api/store/agents/${agentId}/run`, {})
  expect(r1.json.counts.competitors).toMatchObject({ storesChecked: 3, storesSkipped: 1, baselines: 3 })
  await page.goto(`/store/agents/${agentId}`)
  await expect(page.getByRole('heading', { name: 'Competitor findings' })).toBeVisible()
  await expect(page.getByText('Starting point recorded for harbor-home.example')).toBeVisible()
  await expect(page.getByText('Skipped: asks not to be read (robots.txt)')).toBeVisible()
  await expect(page.getByText(/^New on /)).toHaveCount(0)

  await api(page, 'POST', `/api/store/agents/${agentId}/run`, {})
  await page.reload()
  await expect(page.getByText('Price down 16.9% on linen-and-loom.example: Linen Throw Blanket')).toBeVisible()
  await expect(page.getByText('Possible opportunity: ceramic oil pourer')).toBeVisible()
  await expect(page.getByText('Inference', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Observed fact', { exact: true }).first()).toBeVisible()
  await page.goto('/store/agents')
  await expect(page.getByRole('link', { name: /new competitor findings/ }).first()).toBeVisible()
})

test('another organization and staff cannot read the findings', async ({ page }) => {
  await signIn(page, HARBOR)
  expect((await api(page, 'GET', `/api/store/agents/${agentId}/competitors`)).status).toBe(404)
  expect((await api(page, 'POST', `/api/store/agents/${agentId}/competitors`, { status: 'dismissed' })).status).toBe(404)
  await signIn(page, 'hello@getdeploi.com')
  const staff = await api(page, 'POST', `/api/store/agents/${agentId}/competitors`, { status: 'seen' })
  expect([403, 404]).toContain(staff.status)
})
