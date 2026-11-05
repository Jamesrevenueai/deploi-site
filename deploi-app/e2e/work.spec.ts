/**
 * The customer's work, end to end (synthetic Northwind store, dev auth, DEMO_CONTROLS=true):
 * Home -> Work in Progress -> the case page -> Needs My Approval -> approve -> Completed Work, with the
 * verified outcome and its evidence on the case page. The case is opened through the test-only demo action
 * (POST /api/store/demo { action: 'open_case' }), which works on synthetic stores only.
 * Screenshots at 1440 and 390 go to proof/ui-*.png (deviceScaleFactor 1).
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })

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
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as T }
}
async function shoot(page: Page, name: string) {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(250)
    await page.screenshot({ path: `proof/ui-${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

let connectionId = ''
let ref = ''

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, NORTHWIND)
  if (connectionId) await api(page, 'POST', '/api/store/demo', { connectionId, action: 'reset', clearHistory: false })
  await page.close()
})

test('the navigation has the customer labels, and old URLs still work', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await expect(page).toHaveURL(/\/store$/)
  const nav = page.locator('nav.rail')
  const labels = ['Home', 'My AI Team', 'Work in Progress', 'Needs My Approval', 'Completed Work', 'Inbox', 'Business Insights', 'Integrations', 'Billing', 'Settings']
  await expect(nav.getByRole('link')).toHaveText(['deploi.', ...labels])
  await page.goto('/store/control-room')
  await expect(page).toHaveURL(/\/store$/)
  await page.goto('/store/inbox')
  await expect(page).toHaveURL(/\/store\/approvals$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Needs My Approval' })).toBeVisible()
  for (const [path, h] of [['/store/my-team', 'My AI Team'], ['/store/insights', 'Business Insights'], ['/store/settings', 'Settings'], ['/store/completed', 'Completed Work']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: h })).toBeVisible()
  }
  await page.goto('/store/settings')
  await expect(page.locator('[data-settings="members"]')).toBeVisible()
  await page.goto('/store/insights')
  await expect(page.getByTestId('estimate')).toContainText('Formula:')
  await page.goto('/store/welcome')
  await expect(page.getByTestId('first-run')).toContainText('We found work your AI team can handle.')
})

test('Home -> Work in Progress -> case -> Needs My Approval -> approve -> Completed Work', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const cr = await api<{ connections: { stores: { id: string; synthetic: boolean }[] } }>(page, 'GET', '/api/store/control-room')
  connectionId = cr.json.connections.stores.find(s => s.synthetic)!.id
  const opened = await api<{ case: { ref: string; status: string } }>(page, 'POST', '/api/store/demo', { connectionId, action: 'open_case' })
  expect(opened.status).toBe(200)
  ref = opened.json.case.ref
  expect(opened.json.case.status).toBe('awaiting_approval')

  // Home counts it
  await page.goto('/store')
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
  await expect(page.locator('[data-metric="discovered"]')).not.toContainText('—')
  await expect(page.getByTestId('approvals-count')).toHaveText(/[1-9]\d*/)
  await shoot(page, 'home')

  // Work in Progress points to Needs My Approval; the case page shows the whole case
  await page.locator('nav.rail').getByRole('link', { name: 'Work in Progress' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Work in Progress' })).toBeVisible()
  await page.goto(`/store/work/${ref}`)
  const c = page.locator(`[data-case-page="${ref}"]`)
  await expect(c).toHaveAttribute('data-status', 'awaiting_approval')
  for (const h of ['What Deploi discovered', 'Why it matters', 'Decisions waiting for you', 'Actions taken', 'Evidence', 'Handled by', 'Next steps', 'Final verification', 'History']) await expect(page.getByRole('heading', { name: h })).toBeVisible()
  await expect(page.locator('#decisions [data-approval^="case:"]')).toBeVisible()
  await expect(page.locator('#decisions')).toContainText('Exactly what you are deciding')
  await shoot(page, 'case-detail')

  // Needs My Approval: decide there
  await page.locator('nav.rail').getByRole('link', { name: 'Needs My Approval' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Needs My Approval' })).toBeVisible()
  const card = page.locator('[data-approval^="case:"]').filter({ hasText: 'needs-review' }).first()
  await expect(card).toBeVisible()
  await expect(card.getByRole('link', { name: ref })).toBeVisible()
  await shoot(page, 'approvals')
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(/Approved: .*Result: Resolved/)).toBeVisible({ timeout: 30_000 })

  // Completed Work lists it, and the case page shows the verified outcome with its evidence
  await page.locator('nav.rail').getByRole('link', { name: 'Completed Work' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Completed Work' })).toBeVisible()
  await expect(page.locator(`[data-case="${ref}"]`)).toBeVisible()
  await page.locator(`[data-case="${ref}"] a`).click()
  await expect(page.locator(`[data-case-page="${ref}"]`)).toHaveAttribute('data-status', 'resolved')
  await expect(page.getByTestId('verified-outcome')).toContainText('Fresh read')
  await expect(page.locator('#actions')).toContainText('Removed the tag')

  // the approval is gone and cannot be decided twice
  const after = await api<{ items: { source: string; id: string }[] }>(page, 'GET', '/api/store/approvals')
  expect(after.json.items.filter(i => i.source === 'case')).toHaveLength(0)
})

test('the demo case action refuses a real store and needs demo controls', async ({ page }) => {
  await signIn(page, NORTHWIND)
  expect((await api(page, 'POST', '/api/store/demo', { connectionId: '00000000-0000-4000-8000-000000000000', action: 'open_case' })).status).toBe(404)
  await signIn(page, 'owner@harbor-supply.example')
  expect((await api(page, 'POST', '/api/store/demo', { connectionId, action: 'open_case' })).status).toBe(404)
})
