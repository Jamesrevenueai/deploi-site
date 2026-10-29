/**
 * Access at the HTTP level: anonymous visitors are sent to /login; a merchant cannot open staff
 * pages; staff see early access applications and the audit log; the old consulting pages and
 * scheduled jobs are gone; scheduled jobs refuse callers without the cron secret.
 */
import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

const STAFF_PAGES = ['/staff', '/staff/early-access', '/staff/audit']
const RETIRED = ['/app/home', '/app/evv', '/staff/pipeline', '/staff/assessments', '/staff/engagements', '/staff/economics', '/staff/evv', '/staff/queue', '/staff/website', '/staff/setup']

test('anonymous visitors are redirected to /login from every protected page', async ({ page }) => {
  await page.request.post('/logout')
  for (const path of [...STAFF_PAGES, '/store', '/store/agents', '/no-store']) {
    await page.goto(path)
    expect(new URL(page.url()).pathname, path).toBe('/login')
  }
})

test('a merchant cannot open any staff page and is sent to its store', async ({ page }) => {
  await signIn(page, 'owner@northwind-goods.example')
  for (const path of STAFF_PAGES) {
    await page.goto(path)
    expect(new URL(page.url()).pathname, path).toBe('/store')
  }
})

test('staff land on early access applications and can open the audit log', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  expect(new URL(page.url()).pathname).toBe('/staff/early-access')
  await expect(page.getByRole('heading', { name: 'Early access' })).toBeVisible()
  await page.goto('/staff/audit')
  await expect(page.locator('thead th', { hasText: 'Organization' })).toBeVisible()
})

test('the old consulting pages and endpoints are gone', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  for (const path of RETIRED) {
    const r = await page.goto(path)
    expect(r?.status(), path).toBe(404)
  }
  for (const path of ['/api/cron/workers', '/api/cron/morning-report', '/api/cron/morning-pipeline', '/api/evv/billing-hold.csv', '/api/webhooks/twilio']) {
    expect((await page.request.get(path)).status(), path).toBe(404)
  }
  const cron = await page.request.get('/api/cron/agents')
  expect([401, 403]).toContain(cron.status())
})
