/**
 * Access at the HTTP level: anonymous visitors are sent to /login; a merchant cannot open staff
 * pages; staff see early access applications and the audit log; the old consulting pages and
 * scheduled jobs are gone; scheduled jobs refuse callers without the cron secret. The script
 * Content-Security-Policy (nonce + 'strict-dynamic') is sent and the app runs under it without violations.
 */
import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

const STAFF_PAGES = ['/staff', '/staff/early-access', '/staff/audit', '/staff/store-access']
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

test('pages run under the nonce script policy with no CSP violations', async ({ page }) => {
  const violations: string[] = []
  page.on('console', m => { if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) violations.push(m.text()) })
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`)))
  await page.request.post('/logout')
  const login = await page.goto('/login')
  const csp = login!.headers()['content-security-policy'] ?? ''
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
  expect(nonce, csp).toBeTruthy()
  for (const d of ["'strict-dynamic'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(d)
  expect(csp).not.toContain("'unsafe-eval'")
  expect(csp).not.toContain("'unsafe-inline'")
  // every script tag in the document carries this response's nonce
  const html = await login!.text()
  const scripts = html.match(/<script\b[^>]*>/g) ?? []
  expect(scripts.length).toBeGreaterThan(0)
  for (const t of scripts) expect(t).toContain(`nonce="${nonce}"`)
  // hydration works: the client-side sign-in still navigates
  await page.selectOption('select[name=email]', 'owner@northwind-goods.example')
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
  const store = await page.goto('/store/agents')
  expect(store!.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`) // a fresh nonce per response
  // hydrated client pages render (the store polls, so wait for content rather than network idle)
  await expect(page.locator('h1').first()).toBeVisible()
  await page.goto('/store')
  await expect(page.locator('h1').first()).toBeVisible()
  await page.waitForTimeout(1500)
  expect(violations).toEqual([])
})
