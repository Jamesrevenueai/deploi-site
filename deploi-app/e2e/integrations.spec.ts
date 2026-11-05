/**
 * Integration hub end to end (production build, dev auth, DEMO_CONTROLS=true, seed applied): Harbor Supply
 * connects a SYNTHETIC HubSpot, tests it on the Integrations page, the synthetic provider is made to refuse
 * Deploi's authorization (demo control), Test finds it and the card offers Reconnect with the permissions
 * explained; Reconnect restores the same connection and the status is back to connected. Staff see the
 * connection and its transitions at /staff/integrations. Nothing leaves the machine. The connection is
 * disconnected afterwards. Screenshots at 1440 and 390 go to proof/integrations-*.png.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
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

async function shoot(page: Page, name: string) {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `proof/integrations-${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

let connectionId: string | null = null
let officeWasEnabled: boolean | null = null

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, HARBOR)
  if (connectionId) await api(page, 'POST', '/api/store/integrations/hubspot', { op: 'disconnect', connectionId })
  // leave Harbor Supply as the seed had it, so later specs see the same organization
  if (officeWasEnabled === false) await api(page, 'POST', '/api/office/product', { enable: false })
  await page.close()
})

test('Test a synthetic connection, break it, see Reconnect, reconnect, and it is connected again', async ({ page }) => {
  await signIn(page, HARBOR)
  officeWasEnabled = Boolean(((await api(page, 'GET', '/api/office/product')).json as { enabled?: boolean }).enabled)
  expect((await api(page, 'POST', '/api/office/product', { enable: true })).status).toBe(200)
  // a leftover from an interrupted run is disconnected first
  const before = await api<{ integrations: { key: string; connections: { id: string }[] }[] }>(page, 'GET', '/api/store/integrations')
  for (const c of before.json.integrations.find(i => i.key === 'hubspot')?.connections ?? []) await api(page, 'POST', '/api/store/integrations/hubspot', { op: 'disconnect', connectionId: c.id })
  const made = await api<{ result: { kind: string; connectionId: string } }>(page, 'POST', '/api/store/integrations/hubspot', { op: 'connect', synthetic: true })
  expect(made.status).toBe(200)
  expect(made.json.result.kind).toBe('done')
  connectionId = made.json.result.connectionId

  await page.goto('/store/integrations')
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible()
  const card = page.locator('[data-integration="hubspot"]')
  await expect(card).toHaveAttribute('data-status', 'connected')
  for (const k of ['shopify', 'woocommerce', 'google_calendar', 'quickbooks', 'agent_mailbox', 'gmail', 'microsoft', 'stripe']) await expect(page.locator(`[data-integration="${k}"]`)).toBeVisible()
  // customers never see environment variable names
  expect(await page.locator('main').innerText()).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/)

  // Test: a read-only probe, recorded
  await card.getByRole('button', { name: 'Test HubSpot' }).click()
  await expect(card.getByTestId('test-result')).toHaveText('HubSpot answered a contacts read (synthetic test portal).')
  await expect(card.getByTestId('last-check')).toContainText('Last check')
  await shoot(page, 'connected')

  // break it: the synthetic provider now refuses Deploi's authorization, as a revoked grant would
  expect((await api(page, 'POST', '/api/store/integrations/hubspot', { op: 'demo_break', connectionId })).status).toBe(200)
  await card.getByRole('button', { name: 'Test HubSpot' }).click()
  await expect(card).toHaveAttribute('data-status', 'needs_reauth')
  await expect(card.getByTestId('status-label')).toHaveText('Needs reconnecting')
  await expect(card.getByTestId('reconnect-box')).toContainText('Reconnecting keeps this connection, its agents and their work')
  await expect(page.getByTestId('attention')).toContainText('HubSpot needs your attention.')
  await card.getByText('Permissions requested, and why').click()
  await expect(card.getByText('crm.objects.contacts.read', { exact: true })).toBeVisible()
  await shoot(page, 'needs-reconnect')

  // reconnect: same connection, status back to connected
  await card.getByRole('button', { name: 'Reconnect HubSpot' }).click()
  await expect(card.getByTestId('test-result')).toHaveText('HubSpot is reconnected.')
  await expect(card).toHaveAttribute('data-status', 'connected')
  await expect(card.getByTestId('reconnect-box')).toHaveCount(0)
  const after = await api<{ integrations: { key: string; status: string; connections: { id: string }[] }[] }>(page, 'GET', '/api/store/integrations')
  expect(after.json.integrations.find(i => i.key === 'hubspot')).toMatchObject({ status: 'connected', connections: [{ id: connectionId }] })
  await card.getByRole('button', { name: 'Test HubSpot' }).click()
  await expect(card.getByTestId('test-result')).toHaveText('HubSpot answered a contacts read (synthetic test portal).')

  // Advanced: the recent checks, including the refused one
  await card.getByRole('button', { name: 'Advanced diagnostics for HubSpot' }).click()
  const diag = page.getByTestId('diagnostics')
  await expect(diag).toContainText('Recent checks')
  await expect(diag).toContainText(/Reconnect it/)
  await expect(diag.getByText('auth', { exact: true }).first()).toBeVisible()
  await shoot(page, 'diagnostics')
})

test('staff see the connection and its transitions across organizations, with the missing settings', async ({ page }) => {
  test.skip(!connectionId, 'no connection from the previous test')
  await signIn(page, STAFF)
  await page.goto('/staff/integrations')
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible()
  await expect(page.getByTestId('staff-setup')).toContainText('HUBSPOT_CLIENT_ID')
  await expect(page.getByTestId('staff-connections')).toContainText('Synthetic HubSpot (test only)')
  await expect(page.getByText('Needs reconnecting → Connected').first()).toBeVisible()
  expect((await api(page, 'GET', '/api/staff/integrations')).status).toBe(200)
  // staff cannot change a customer's connection
  expect((await api(page, 'POST', '/api/store/integrations/hubspot', { op: 'test' })).status).toBe(403)
})
