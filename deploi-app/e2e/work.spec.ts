/**
 * The customer's work, end to end (synthetic Northwind store, dev auth, DEMO_CONTROLS=true):
 * Command center -> Work in Progress -> the case page -> Needs you -> approve -> Proof log (Completed Work), with the
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
  const nav = page.getByRole('navigation', { name: 'Main' })
  const labels = ['Command center', 'Needs you', 'My agents', 'Team room', 'Agent library', 'Proof log', 'Connections', 'Plan & actions']
  // a label may carry its live count after it ("Needs you 2", "My agents 5")
  await expect(nav.getByRole('link')).toHaveText(labels.map(l => new RegExp(`^${l.replace(/[&]/g, '\\$&')}\\s*\\d*$`)))
  await expect(nav.getByRole('link', { name: /^Command center/ })).toHaveAttribute('aria-current', 'page')
  await page.goto('/store/control-room')
  await expect(page).toHaveURL(/\/store$/)
  await page.goto('/store/inbox')
  await expect(page).toHaveURL(/\/store\/approvals$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible()
  for (const [path, h] of [['/store/my-team', 'My AI Team'], ['/store/insights', 'Business Insights'], ['/store/settings', 'Settings'], ['/store/completed', 'Completed Work']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: h })).toBeVisible()
  }
  await page.goto('/store/settings')
  await expect(page.locator('[data-settings="members"]')).toBeVisible()
  await page.goto('/store/insights')
  await expect(page.getByTestId('estimate')).toContainText('Formula:')
  // the discovery first run is a step of the one setup path now; the old URL redirects there
  await page.goto('/store/welcome')
  await expect(page).toHaveURL(/\/store\/setup$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Deploi' })).toBeVisible()
})

test('Command center -> Work in Progress -> case -> Needs you -> approve -> Proof log (Completed Work)', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const cr = await api<{ connections: { stores: { id: string; synthetic: boolean }[] } }>(page, 'GET', '/api/store/control-room')
  connectionId = cr.json.connections.stores.find(s => s.synthetic)!.id
  const opened = await api<{ case: { ref: string; status: string } }>(page, 'POST', '/api/store/demo', { connectionId, action: 'open_case' })
  expect(opened.status).toBe(200)
  ref = opened.json.case.ref
  expect(opened.json.case.status).toBe('awaiting_approval')

  // the Command center counts it: the sidebar's Needs you carries the count
  await page.goto('/store')
  await expect(page.getByRole('heading', { level: 1, name: /Your team is on it\.$/ })).toBeVisible()
  await expect(page.getByTestId('command-center')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Needs you/ })).toContainText(/[1-9]/)
  await shoot(page, 'home')

  // Work in Progress points to Needs you; the case page shows the whole case
  await page.goto('/store/work')
  await expect(page.getByRole('heading', { level: 1, name: 'Work in Progress' })).toBeVisible()
  await page.goto(`/store/work/${ref}`)
  const c = page.locator(`[data-case-page="${ref}"]`)
  await expect(c).toHaveAttribute('data-status', 'awaiting_approval')
  for (const h of ['What Deploi discovered', 'Why it matters', 'Decisions waiting for you', 'Actions taken', 'Evidence', 'Handled by', 'Next steps', 'Final verification', 'History']) await expect(page.getByRole('heading', { name: h })).toBeVisible()
  await expect(page.locator('#decisions [data-approval^="case:"]')).toBeVisible()
  await expect(page.locator('#decisions')).toContainText('Exactly what you are deciding')
  await shoot(page, 'case-detail')

  // Needs you: decide there
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Needs you/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible()
  const card = page.locator('[data-approval^="case:"]').filter({ hasText: 'needs-review' }).first()
  await expect(card).toBeVisible()
  await expect(card.getByRole('link', { name: ref })).toBeVisible()
  await shoot(page, 'approvals')
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(/Approved: .*Result: Resolved/)).toBeVisible({ timeout: 30_000 })

  // Completed Work lists it, and the case page shows the verified outcome with its evidence
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Proof log' }).click()
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

test('Privacy requests: the page lists exports and requests (merchant only); a case decided elsewhere cannot be closed from its page', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/settings')
  await page.getByRole('link', { name: 'Privacy requests' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy requests' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Customer data exports' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'All requests' })).toBeVisible()
  await expect(page.getByText('Deploi does not read your Shopify customers or orders')).toBeVisible()
  const list = await api<{ exports: unknown[]; requests: unknown[] }>(page, 'GET', '/api/store/privacy')
  expect(list.status).toBe(200)
  expect(Array.isArray(list.json.exports)).toBe(true)
  expect((await api(page, 'GET', '/api/store/privacy/00000000-0000-4000-8000-000000000000')).status).toBe(404)
  await shoot(page, 'privacy')
  if (ref) {
    const c = await api<{ close: unknown }>(page, 'GET', `/api/store/cases/${ref}`)
    expect(c.json.close).toBeNull()
    await page.goto(`/store/work/${ref}`)
    await expect(page.locator('#close')).toHaveCount(0)
  }
})
