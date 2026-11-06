/**
 * Launch build (2026-11-07) proof pass: every new screen of the standalone app in a real browser, at 1440 and 390.
 * Production build, dev auth, DEMO_CONTROLS=true, synthetic providers only (AI_PROVIDER=off). For each business type
 * the owner picks, the matching agent packs show; each pack page lists its agents with an honest status.
 * Screenshots: proof/launch/<name>-1440.png and -390.png.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const OWNER = 'owner@northwind-goods.example'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}
async function api(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(path, { method, data: body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: await res.json().catch(() => ({})) as Record<string, unknown> }
}
async function pair(page: Page, name: string) {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => null)
    await page.waitForTimeout(250)
    // no horizontal page scroll at phone width
    if (w === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} overflows at 390`).toBeLessThanOrEqual(391)
    await page.screenshot({ path: `proof/launch/${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function visit(page: Page, path: string, name: string, heading?: RegExp) {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  const res = await page.goto(path)
  expect(res?.status(), path).toBeLessThan(400)
  await expect(page.getByRole('heading', { level: 1, ...(heading ? { name: heading } : {}) }).first()).toBeVisible()
  await pair(page, name)
  expect(errors, `${path} page errors`).toEqual([])
}

const TYPES: { type: string; packs: string[] }[] = [
  { type: 'store', packs: ['commerce', 'office'] },
  { type: 'home_services', packs: ['home_services'] },
  { type: 'leasing_agent', packs: ['leasing'] },
  { type: 'real_estate_agent', packs: ['real_estate'] },
  { type: 'property_manager', packs: ['property_management'] },
]

test('every business type shows its packs; each pack page renders its agents', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, OWNER)
  for (const t of TYPES) {
    const r = await api(page, 'POST', '/api/store/packs', { op: 'business-type', businessType: t.type, ...(t.type === 'home_services' ? { trade: 'hvac' } : {}) })
    expect(r.status, `business type ${t.type}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(200)
    await visit(page, '/store/packs', `packs-${t.type}`)
    for (const p of t.packs) {
      await visit(page, `/store/packs/${p}`, `pack-${p}`)
      // every agent card says what it does and how far it is (synthetic only / working), never an empty page
      await expect(page.locator('main')).toContainText(/test data only|working|ready/i)
    }
  }
  // back to a store for the other specs
  expect((await api(page, 'POST', '/api/store/packs', { op: 'business-type', businessType: 'store' })).status).toBe(200)
})

test('settings (agent modes, owner updates), connections, setup and approvals', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, OWNER)
  await visit(page, '/store/settings', 'settings')
  await expect(page.locator('main')).toContainText(/ask me first|do it and tell me/i)
  await visit(page, '/store/integrations', 'integrations')
  for (const name of ['Salesforce', 'Pipedrive', 'Zoho', 'Buildium', 'QuickBooks']) await expect(page.locator('main'), name).toContainText(name)
  await visit(page, '/store/setup', 'setup')
  await visit(page, '/store/approvals', 'approvals')
})
