/**
 * Staff operations console end to end (production build, dev auth, seeded data): staff see the global switches
 * with instructions, the queue, alerts, case search and operational logs; they stop an organization's agents on
 * the customer's behalf and turn the stop off again (agents stay paused); a merchant and an anonymous visitor
 * cannot open the console. Saves a 1440/390 screenshot pair in proof/.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

test('anonymous visitors and merchants cannot open the operations console', async ({ page }) => {
  await page.request.post('/logout')
  await page.goto('/staff/ops')
  expect(new URL(page.url()).pathname).toBe('/login')
  await signIn(page, 'owner@northwind-goods.example')
  await page.goto('/staff/ops')
  expect(new URL(page.url()).pathname).toBe('/store')
})

test('staff see switches, queue, alerts, case search and logs; stop and clear an organization', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto('/staff/ops')
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
  await expect(page.getByText(/JOBS_PAUSED is (on|off)\./)).toBeVisible()
  await expect(page.getByText(/LIVE_WRITES is (on|off)\./)).toBeVisible()
  await expect(page.getByTestId('dead-count')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Operational logs' })).toBeVisible()
  // nothing on the page approves, grants or resumes
  await expect(page.getByRole('button', { name: /approve|grant|resume/i })).toHaveCount(0)

  await page.getByLabel('Case reference', { exact: true }).fill('DC-999999')
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.getByText('No case DC-999999')).toBeVisible()

  await page.getByLabel('Organization', { exact: true }).fill('Northwind')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('a.badge', { hasText: 'Northwind' }).first().click()
  const org = page.getByTestId('org-view')
  await expect(org).toBeVisible()
  await expect(org.getByText('running')).toBeVisible()
  await org.getByLabel('Reason').fill('e2e drill')
  await org.getByRole('button', { name: 'Stop all agents' }).click()
  await expect(page.getByText('All agents of the organization are stopped.')).toBeVisible()
  await expect(page.getByTestId('org-view').getByText('all agents stopped')).toBeVisible()
  await expect(page.getByTestId('org-view').getByText(/stopped by Deploi support: e2e drill/)).toBeVisible()
  await page.getByTestId('org-view').getByRole('button', { name: /Turn the stop off/ }).click()
  await expect(page.getByText('The stop is off. Agents stay paused until the customer resumes them.')).toBeVisible()
  await expect(page.getByTestId('org-view').getByText('running')).toBeVisible()

  for (const [w, h, name] of [[1440, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.screenshot({ path: `proof/ops-console-${name}.png`, fullPage: true })
  }
})
