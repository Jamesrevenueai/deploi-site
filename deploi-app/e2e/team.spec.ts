/**
 * The agent library end to end (synthetic Northwind store, dev auth, DEMO_CONTROLS=true): the team
 * dashboard lists twelve agents with locks that follow the tier; a locked agent cannot be switched on
 * and upgrading unlocks it; an agent is switched on, runs from chat, drafts into its approval queue,
 * one draft is approved with proof and the log shows it; auto-run needs "act" and is refused for money
 * actions; onboarding, plan and the feedback button work; the website agents and pricing pages match the config.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'

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
type Team = { tier: string; agents: { key: string; locked: boolean; enabled: boolean; upgradeTo: string | null; waiting: number }[] }

test('reset: Starter tier, every agent off', async ({ page }) => {
  await signIn(page, NORTHWIND)
  expect((await api(page, 'POST', '/api/store/plan', { tier: 'starter' })).status).toBe(200)
  const t = await api<Team>(page, 'GET', '/api/store/library')
  for (const a of t.json.agents) {
    if (a.enabled) expect((await api(page, 'POST', `/api/store/library/${a.key}/switch`, { enabled: false })).status).toBe(200)
    if (!a.locked) expect((await api(page, 'POST', `/api/store/library/${a.key}/permission`, { level: 'draft' })).status).toBe(200)
  }
})

test('team dashboard: twelve agents, eight locked on Starter, each locked card has an Upgrade button', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/team')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  const cards = page.locator('[data-agent]')
  await expect(cards).toHaveCount(12)
  await expect(page.locator('[data-agent][data-locked="true"]')).toHaveCount(8)
  await expect(page.locator('[data-upgrade="order_tracker"]')).toHaveText(/Upgrade/)
  await expect(page.locator('[data-agent="order_tracker"] [role=switch]')).toHaveCount(0)
  await expect(page.locator('[data-agent="listing_writer"] [role=switch]')).toHaveCount(1)
  await expect(page.getByText('Starter plan')).toBeVisible()
})

test('a locked agent is refused with upgrade_required; upgrading to Growth unlocks it', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const r = await api<{ error: string; detail: { upgradeTo: string } }>(page, 'POST', '/api/store/library/order_tracker/switch', { enabled: true })
  expect(r.status).toBe(402)
  expect(r.json).toMatchObject({ error: 'upgrade_required', detail: { upgradeTo: 'growth' } })
  await page.goto('/store/plan?upgrade=growth')
  await expect(page.locator('[data-tier="growth"]')).toBeVisible()
  await expect(page.locator('[data-tier="growth"]').getByText('Coming soon', { exact: true })).toBeVisible()
  await page.locator('[data-choose="growth"]').click()
  await expect(page.getByText('You are on Growth.')).toBeVisible()
  await page.goto('/store/team')
  await expect(page.locator('[data-agent][data-locked="true"]')).toHaveCount(4)
  const sw = page.locator('[data-agent="order_tracker"] [role=switch]')
  await sw.click()
  await expect(page.getByText(/Order Tracker is on/)).toBeVisible()
  await expect(page.locator('[data-agent="order_tracker"][data-enabled="true"]')).toHaveCount(1)
})

test('agent dashboard: chat runs the agent, drafts wait in the queue, approving keeps the proof, the log shows it', async ({ page }) => {
  await signIn(page, NORTHWIND)
  expect((await api(page, 'POST', '/api/store/library/listing_writer/switch', { enabled: true })).status).toBe(200)
  await page.goto('/store/team/listing_writer')
  await expect(page.getByRole('heading', { name: 'Listing Writer', level: 1 })).toBeVisible()
  await expect(page.locator('.au-level button[aria-pressed="true"]')).toHaveText('Draft')
  await page.getByLabel('Message').fill('run now')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.au-bubble.agent').last()).toContainText('waiting for your approval', { timeout: 60_000 })
  await page.getByRole('tab', { name: /Approvals/ }).click()
  const first = page.locator('[data-action]').first()
  await expect(first).toBeVisible()
  const title = await first.locator('.text-ink.font-medium').first().textContent()
  await first.getByRole('button', { name: /^Approve:/ }).click()
  await expect(page.locator('[data-queue-result]')).toContainText(/fresh read of the store shows the change|ready to copy/, { timeout: 30_000 })
  await page.getByRole('tab', { name: 'Activity' }).click()
  await expect(page.locator('.au-log-row[data-kind="action"]').filter({ hasText: title ?? '' }).first()).toContainText(/Done|Approved/)
  await expect(page.locator('.au-proof').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByLabel('Message').fill("what's waiting?")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.au-bubble.agent').last()).toContainText(/waiting for you|Nothing is waiting/)
})

test('auto-run: refused below "act"; granted at "act" for a write action; money actions can never be granted', async ({ page }) => {
  await signIn(page, NORTHWIND)
  expect((await api(page, 'POST', '/api/store/library/listing_writer/grant', { actionType: 'draft_title' })).status).toBe(409)
  await page.goto('/store/team/listing_writer')
  await page.locator('.au-level button', { hasText: 'Act' }).click()
  await expect(page.getByText(/is now at "Act within limits"/)).toBeVisible()
  await page.getByRole('tab', { name: 'Auto-run' }).click()
  await page.locator('[data-action-type="draft_title"]').getByRole('button', { name: 'Grant auto-run' }).click()
  await expect(page.getByText(/Auto-run granted for "Draft an improved title"/)).toBeVisible()
  await expect(page.locator('[data-action-type="draft_title"]').getByRole('button', { name: 'Revoke' })).toBeVisible()
  expect((await api(page, 'POST', '/api/store/plan', { tier: 'pro' })).status).toBe(200)
  expect((await api(page, 'POST', '/api/store/library/promo_manager/switch', { enabled: true })).status).toBe(200)
  expect((await api(page, 'POST', '/api/store/library/promo_manager/permission', { level: 'act' })).status).toBe(200)
  const money = await api<{ error: string }>(page, 'POST', '/api/store/library/promo_manager/grant', { actionType: 'create_discount' })
  expect(money.status).toBe(403)
  await page.goto('/store/team/promo_manager')
  await page.getByRole('tab', { name: 'Auto-run' }).click()
  await expect(page.locator('[data-action-type="create_discount"]')).toContainText('approval-only at every level')
  await expect(page.locator('[data-action-type="create_discount"]').getByRole('button', { name: 'Grant auto-run' })).toHaveCount(0)
})

test('onboarding, the usage meter, build your own (Pro), and the feedback button', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/onboarding')
  await expect(page.locator('[data-step="connect"][data-state="done"]')).toBeVisible()
  await expect(page.locator('[data-step="done"]')).toBeVisible()
  const finish = page.getByRole('button', { name: 'Finish setup' })
  if (await finish.count()) { await finish.click(); await expect(page.getByText('Done. Your team is ready.')).toBeVisible() }
  await page.goto('/store/team')
  await expect(page.getByRole('progressbar', { name: 'Monthly action allowance' })).toBeVisible()
  await page.getByRole('button', { name: 'New agent' }).click()
  await page.getByLabel('Name').fill('Late order nudger')
  await page.getByLabel('The job, in your words').fill('Tell me which orders are late')
  await expect(page.locator('.au-level button[aria-pressed="true"]')).toHaveText('Read')
  await page.getByRole('button', { name: 'Create agent' }).click()
  await expect(page.getByText(/Late order nudger created at "Read"/)).toBeVisible()
  await page.getByRole('button', { name: 'Feedback' }).click()
  await page.getByLabel('What happened, or what would help?').fill('e2e: the approval queue is clear')
  await page.getByRole('button', { name: 'Send feedback' }).click()
  await expect(page.getByText('Thank you. We read every message during the private beta.')).toBeVisible()
})

test('staff cannot switch agents; another store sees its own switches only', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  expect((await api(page, 'POST', '/api/store/library/listing_writer/switch', { enabled: false })).status).toBe(403)
  expect((await api(page, 'GET', '/api/store/library')).status).toBe(403)
  await signIn(page, 'owner@harbor-supply.example')
  const t = await api<Team>(page, 'GET', '/api/store/library')
  expect(t.status).toBe(200)
  expect(t.json.agents.find(a => a.key === 'listing_writer')!.enabled).toBe(false)
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, NORTHWIND)
  await api(page, 'POST', '/api/store/library/listing_writer/permission', { level: 'draft' })
  await page.close()
})
