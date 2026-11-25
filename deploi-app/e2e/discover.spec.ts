/**
 * Business discovery end to end (synthetic Northwind store, dev auth): the owner opens /store/discover,
 * runs discovery, sees real findings ("We found work your AI team can handle."), sets up the recommended
 * team at drafts only and grants every shown policy in one request — three clicks from a connected store
 * to working monitoring agents. Setting up again creates nothing new. Harbor sees none of Northwind's
 * findings; staff are refused. Agents this spec creates are deleted afterwards.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const STAFF = 'hello@getdeploi.com'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as T }
}

type Team = { template: string; agent: { agentId: string; agentKind: string; status: string; pending: { draftsOnly: boolean } | null } | null }[]
const view = async (page: Page) => (await api<{ team: Team; findings: { total: number }; run: { status: string } | null }>(page, 'GET', '/api/store/discover')).json

const created: string[] = []

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, NORTHWIND)
  for (const t of (await view(page)).team) if (t.agent && t.agent.agentKind === 'engine' && !created.includes(t.agent.agentId)) created.push(t.agent.agentId)
  for (const id of created) await api(page, 'DELETE', `/api/store/agents/${id}`)
  await page.close()
})

test('discover, set up the recommended team at drafts only, grant all shown', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const before = await view(page)
  // agents an earlier run left behind are not this spec's to grant: start from none set up
  for (const t of before.team) if (t.agent && t.agent.agentKind === 'engine') { created.push(t.agent.agentId); await api(page, 'DELETE', `/api/store/agents/${t.agent.agentId}`) }

  await page.goto('/store/discover')
  // click 1: discover
  await page.getByRole('button', { name: /Discover my business|Run discovery again/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'We found work your AI team can handle.' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('findings').locator('li').first()).toBeVisible()
  await expect(page.getByTestId('team')).toContainText('Inventory Watcher')
  await expect(page.getByTestId('team')).toContainText('Drafts only')
  await expect(page.getByTestId('team')).toContainText("your supplier's email address")
  await expect(page.getByTestId('profile')).toContainText('Items (variants)')

  // click 2: set up the recommended team (drafts only); the policies to grant are shown
  await page.getByRole('button', { name: 'Set up recommended team' }).click()
  const grant = page.getByRole('button', { name: /Grant all shown/ })
  await expect(grant).toBeVisible()
  await expect(page.getByTestId('policy-summary').first()).toBeVisible()
  let v = await view(page)
  const pending = v.team.filter(t => t.agent?.pending?.draftsOnly)
  expect(pending.map(t => t.template).sort()).toEqual(['inventory_watcher', 'store_health_checker'])
  for (const t of pending) created.push(t.agent!.agentId)

  // click 3: grant every shown policy in one request
  await grant.click()
  await expect(page.getByText(/agents are now working, at drafts only/)).toBeVisible()
  v = await view(page)
  expect(v.team.filter(t => t.agent?.status === 'active').map(t => t.template).sort()).toEqual(['inventory_watcher', 'store_health_checker'])
  await page.screenshot({ path: 'proof/discover-1440.png', fullPage: true })

  // setting up again creates nothing new
  const again = await api<{ items: { status: string }[] }>(page, 'POST', '/api/store/discover/team', { op: 'create' })
  expect(again.status).toBe(200)
  expect(again.json.items.filter(i => i.status === 'created')).toEqual([])
})

test('another organization sees none of it; staff are refused', async ({ page }) => {
  await signIn(page, HARBOR)
  const hb = await view(page)
  expect(hb.team.some(t => t.agent && created.includes(t.agent.agentId))).toBe(false)
  const grant = await api<{ results: { ok: boolean }[] }>(page, 'POST', '/api/store/discover/team', { op: 'grant', grants: created.map(agentId => ({ agentId, policyHash: 'x' })) })
  expect([200, 400]).toContain(grant.status)
  if (grant.status === 200) expect(grant.json.results.every(r => !r.ok)).toBe(true)

  await signIn(page, STAFF)
  expect((await api(page, 'GET', '/api/store/discover')).status).toBe(403)
  expect((await api(page, 'POST', '/api/store/discover', {})).status).toBe(403)
})
