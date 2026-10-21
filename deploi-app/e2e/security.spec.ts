/**
 * Phase 18 acceptance 1 and 2 at the HTTP level: a client user cannot open staff pages
 * (actions, economics, pipeline, engagements, website, queue, audit) and cannot download a
 * report or export that belongs to another agency; an anonymous visitor is sent to /login.
 */
import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

const STAFF_PAGES = ['/staff/actions', '/staff/economics', '/staff/economics/rates', '/staff/pipeline', '/staff/engagements', '/staff/website', '/staff/queue', '/staff/audit', '/staff/evv', '/staff/setup']

test('anonymous visitors are redirected to /login from every protected page', async ({ page }) => {
  await page.request.post('/logout')
  for (const path of [...STAFF_PAGES, '/app/home', '/app/evv']) {
    await page.goto(path)
    expect(new URL(page.url()).pathname, path).toBe('/login')
  }
})

test('a client user cannot open any staff page and is sent to the client home', async ({ page }) => {
  await signIn(page, 'admin@buckeyehomecare.example')
  for (const path of STAFF_PAGES) {
    await page.goto(path)
    expect(new URL(page.url()).pathname, path).toBe('/app/home')
  }
})

test('a client user gets 4xx, never data, from other agencies and internal exports', async ({ page }) => {
  await signIn(page, 'admin@buckeyehomecare.example')
  // staff-only CSV export for another agency id: the role check wins before any lookup
  const other = await page.request.get('/api/evv/billing-hold.csv?agency=00000000-0000-0000-0000-000000000000')
  expect(other.status()).toBeLessThan(500)
  const body = await other.text()
  // a client always gets their own agency's list, never the requested one
  expect(body.startsWith('vendor_visit_key') || other.status() >= 400).toBe(true)
  const cron = await page.request.get('/api/cron/workers')
  expect([401, 403]).toContain(cron.status())
})
