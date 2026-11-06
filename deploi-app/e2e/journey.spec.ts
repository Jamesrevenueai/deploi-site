/**
 * The whole customer journey in one run, for a brand-new account (production build, dev auth, DEMO_CONTROLS=true,
 * synthetic QuickBooks and a synthetic mailbox only; nothing leaves this machine):
 *   1 sign up            2 name the business        3 choose Deploi Office
 *   4 connect tools      5 discover the business    6 set up the recommended team (drafts only) and grant it
 *   7 approve the exact reminder the agent drafted   8 the customer pays; Deploi verifies it in QuickBooks
 *   9 the case is Completed Work with the QuickBooks evidence
 *  10 the account around it: billing, members (an invitation), integrations and privacy (data)
 * Step 8 changes the synthetic QuickBooks company the way a real customer's payment would (a Payment linked
 * to the invoice), through the e2e database: E2E_DATABASE_URL must name the server's database.
 * Screenshots at 1440 and 390 go to proof/journey-*.png.
 */
import { test, expect, type Page } from '@playwright/test'
import { Client } from 'pg'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })
test.skip(!process.env.E2E_DATABASE_URL, 'set E2E_DATABASE_URL to the server\'s database (step 8 records the customer\'s payment in synthetic QuickBooks)')

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const RUN = Date.now().toString(36)
const EMAIL = `journey.${RUN}@e2e-journey.example`

async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as T }
}
async function shoot(page: Page, name: string) {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(250)
    await page.screenshot({ path: `proof/journey-${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.E2E_DATABASE_URL }); await c.connect()
  try { return (await c.query(text, params)).rows as T[] } finally { await c.end() }
}

test('the customer journey: sign up to a verified, completed case, and the account around it', async ({ page }) => {
  test.setTimeout(240_000)
  // 1-2: sign up, name the business; the new account owns its own organization
  await page.request.post('/logout')
  await page.goto('/login')
  await page.getByLabel('New account email').fill(EMAIL)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(u => u.pathname === '/start')
  await page.getByLabel('Business name').fill(`Journey Studio ${RUN}`)
  await page.getByRole('button', { name: 'Create my business' }).click()
  await page.waitForURL(u => u.pathname === '/store/setup')
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Deploi' })).toBeVisible()
  await shoot(page, '01-setup')

  // 3: products
  await page.getByLabel(/Deploi Commerce/).uncheck()
  await page.getByLabel(/Deploi Office/).check()
  await page.locator('[data-step="products"]').getByRole('button', { name: 'Save and continue' }).click()

  // 4: connect synthetic QuickBooks and a synthetic mailbox
  const connect = page.locator('[data-step="connect"]')
  await expect(connect).toHaveAttribute('data-raw-state', 'current')
  await connect.getByRole('link', { name: /Connect HubSpot, Google Calendar, QuickBooks or a mailbox/ }).click()
  await page.waitForURL(u => u.pathname === '/office/connections')
  const qbo = page.locator('div').filter({ has: page.getByRole('heading', { name: 'QuickBooks Online', exact: false }) }).filter({ has: page.getByRole('button', { name: 'Use a synthetic one (test)' }) }).last()
  await qbo.getByRole('button', { name: 'Use a synthetic one (test)' }).click()
  await expect(page.getByText(/Synthetic QuickBooks/)).toBeVisible()
  await page.getByRole('button', { name: 'Add a synthetic mailbox (test)' }).click()
  await expect(page.getByText(/Synthetic/, { exact: true }).first()).toBeVisible()
  await page.getByRole('link', { name: 'continue setup' }).click()
  await page.waitForURL(u => u.pathname === '/store/setup')

  // 5-6: discover, set up the recommended team at drafts only, grant what is shown
  const step = page.locator('[data-step="discover"]')
  await step.getByRole('button', { name: 'Discover my business' }).click()
  await expect(step.getByRole('heading', { name: 'We found work your AI team can handle.' })).toBeVisible({ timeout: 60_000 })
  await expect(step.getByTestId('team')).toContainText('Accounts Receivable')
  await shoot(page, '05-discovered')
  await step.getByRole('button', { name: 'Set up recommended team' }).click()
  await step.getByRole('button', { name: /Grant all shown/ }).click()
  await expect(page.getByText(/(now working, at drafts only|\d+ agents? working at drafts only)/).first()).toBeVisible()
  await page.locator('[data-step="done"]').getByRole('button', { name: 'Finish setup' }).click()
  await expect(page.getByText('Done. Your team is ready.')).toBeVisible()

  type Team = { template: string; agent: { agentKind: string; agentId: string; status: string } | null }[]
  const ar = (await api<{ team: Team }>(page, 'GET', '/api/store/discover')).json.team.find(t => t.template === 'accounts_receivable')!.agent!
  expect(ar).toMatchObject({ agentKind: 'office', status: 'active' })

  // 7: drafts only sends nothing, so the owner widens email to "After my approval" (a new version that waits for a
  // grant), grants exactly it, runs the agent, then reads the exact reminder and approves it
  await page.goto('/office/agents')
  const agentCard = page.locator('li').filter({ has: page.getByRole('heading', { level: 3, name: /Accounts Receivable/ }) }).first()
  await agentCard.getByRole('button', { name: 'Change permission' }).click()
  await agentCard.getByLabel('Email permission').selectOption('send_approved')
  await agentCard.getByRole('button', { name: 'Save as a new version' }).click()
  await expect(page.getByText(/waits for your grant/).first()).toBeVisible()
  await agentCard.getByRole('button', { name: 'Grant exactly this' }).click()
  await expect(page.getByText(/Granted version 2/)).toBeVisible()
  await shoot(page, '07-permission')
  expect((await api(page, 'POST', `/api/office/agents/${ar.agentId}`, { op: 'run' })).status).toBe(200)
  await page.goto('/store/approvals')
  await expect(page.getByRole('heading', { level: 1, name: 'Needs My Approval' })).toBeVisible()
  const card = page.locator('[data-approval^="office:"]').filter({ hasText: '1037' }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText('accounts@brightpath.example')
  await shoot(page, '07-approval')
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(/Approved/).first()).toBeVisible({ timeout: 30_000 })

  // the reminder went out through the connected mailbox, and the case is waiting for the payment
  type CaseItem = { ref: string; status: string; kind: string; title: string }
  const open = (await api<{ cases: CaseItem[] }>(page, 'GET', '/api/store/cases?suite=office')).json.cases.find(c => /1037/.test(c.title))!
  expect(open).toBeTruthy()
  // sent now, or (in quiet hours) approved and waiting for the morning: either way no longer waiting for the owner
  expect(['executing', 'waiting_external']).toContain(open.status)

  // 8: the customer pays invoice 1037 in full (QuickBooks records a Payment linked to the invoice)
  const [conn] = await sql<{ id: string }>(`select c.id from office_connections c join agencies a on a.id = c.org_id where a.name = $1 and c.provider = 'quickbooks' and c.is_synthetic`, [`Journey Studio ${RUN}`])
  const [{ state }] = await sql<{ state: { nextId: number; invoices: { id: string; balance: number; totalAmt: number; customerId: string; linkedPaymentIds: string[]; updatedAt: string }[]; payments: unknown[] } }>(`select state from office_synthetic_state where connection_id = $1`, [conn.id])
  const inv = state.invoices.find(i => i.id === '1037')!
  const pid = String(state.nextId++)
  state.payments.push({ id: pid, totalAmt: inv.balance, txnDate: new Date().toISOString().slice(0, 10), customerId: inv.customerId, appliedTo: [{ invoiceId: '1037', amount: inv.balance }] })
  inv.balance = 0; inv.linkedPaymentIds = [...inv.linkedPaymentIds, pid]; inv.updatedAt = new Date().toISOString()
  await sql(`update office_synthetic_state set state = $2, updated_at = now() where connection_id = $1`, [conn.id, JSON.stringify(state)])
  // the next run reads QuickBooks again and resolves the case only on that fresh read
  expect((await api(page, 'POST', `/api/office/agents/${ar.agentId}`, { op: 'run' })).status).toBe(200)

  // 9: Completed Work, with the QuickBooks read as the evidence
  await page.goto('/store/completed')
  await expect(page.getByRole('heading', { level: 1, name: 'Completed Work' })).toBeVisible()
  await expect(page.locator(`[data-case="${open.ref}"]`)).toBeVisible({ timeout: 30_000 })
  await page.goto(`/store/work/${open.ref}`)
  await expect(page.locator(`[data-case-page="${open.ref}"]`)).toHaveAttribute('data-status', 'resolved')
  await expect(page.getByTestId('verified-outcome')).toContainText('QuickBooks')
  await expect(page.locator('#evidence')).toContainText('1037')
  await shoot(page, '09-completed')

  // 10: the account around the work
  await page.locator('nav.rail').getByRole('link', { name: 'Billing' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
  await shoot(page, '10-billing')
  await page.goto('/store/settings')
  await page.getByLabel('Email', { exact: true }).fill(`teammate.${RUN}@e2e-journey.example`)
  await page.getByLabel('Role', { exact: true }).selectOption('viewer')
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByTestId('members').locator(`[data-invite="teammate.${RUN}@e2e-journey.example"]`)).toContainText('viewer')
  await page.locator('nav.rail').getByRole('link', { name: 'Integrations' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible()
  await expect(page.getByText(/QuickBooks/).first()).toBeVisible()
  await shoot(page, '10-integrations')
  await page.goto('/store/privacy')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await shoot(page, '10-privacy')
})
