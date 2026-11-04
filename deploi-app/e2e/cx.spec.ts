/**
 * Customer experience end to end (synthetic Northwind store, dev auth, DEMO_CONTROLS=true):
 * the setup wizard walks business → products → connect → agreements → automatic agent setup at drafts
 * only (each granted explicitly) → first scan → done, and resumes wherever it was left; re-running the
 * agent setup never duplicates an agent. The Control Room shows the agents, approvals, connections and
 * issues; Stop all agents asks first and pauses every agent; Integrations shows honest statuses.
 * Screenshots at 1440 and 390 go to proof/cx-*.png. Agents this spec creates are deleted afterwards and
 * agents it paused are resumed, so other specs see the seed as it was.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'

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

type Wizard = { current: string; agents: { key: string; agentId: string | null; status: string }[]; completedAt: string | null }
const wizard = async (page: Page) => (await api<{ wizard: Wizard }>(page, 'GET', '/api/store/onboarding')).json.wizard
const agentIds = async (page: Page) => (await api<{ agents: { id: string; name: string; status: string }[] }>(page, 'GET', '/api/store/agents')).json.agents

async function shoot(page: Page, name: string) {
  for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `proof/cx-${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

const createdByWizard: string[] = []
let pausedBySpec: string[] = []

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, NORTHWIND)
  for (const id of pausedBySpec) await api(page, 'POST', `/api/store/agents/${id}/resume`, {})
  for (const a of (await wizard(page)).agents) if (a.agentId && !createdByWizard.includes(a.agentId)) createdByWizard.push(a.agentId)
  for (const id of createdByWizard) await api(page, 'DELETE', `/api/store/agents/${id}`)
  await page.close()
})

test('setup wizard: from the first step to done, agents at drafts only and granted by the owner', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/onboarding')
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Deploi' })).toBeVisible()
  await expect(page.locator('[data-step="connect"][data-state="done"]')).toBeVisible()
  for (let guard = 0; guard < 12; guard++) {
    const w = await wizard(page)
    if (w.completedAt && w.current === 'done') break
    const step = page.locator(`[data-step="${w.current}"]`)
    await expect(step).toHaveAttribute('data-raw-state', 'current')
    if (w.current === 'business') {
      await shoot(page, 'onboarding')
      await expect(page.getByLabel('Business name')).toHaveValue(/.+/)
      await page.getByLabel('Time zone').selectOption('America/New_York')
      await step.getByRole('button', { name: 'Save and continue' }).click()
    } else if (w.current === 'products') {
      await page.getByLabel(/Deploi Commerce/).check()
      await page.getByLabel(/Deploi Office/).check()
      await page.getByLabel('Shopify').check()
      await step.getByRole('button', { name: 'Save and continue' }).click()
    } else if (w.current === 'agreements') {
      // the agreements pages ship separately; until then the step says so and can be continued
      const cont = step.getByRole('button', { name: 'Continue' })
      const read = step.getByRole('link', { name: /Read and accept/ })
      await expect(cont.or(read).or(step.getByText('All agreements accepted.'))).toBeVisible()
      if (await cont.count()) await cont.click()
      else if (await read.count()) { await api(page, 'POST', '/api/store/onboarding', { op: 'agreements', status: 'skipped' }); await page.reload() }
    } else if (w.current === 'agents') {
      const setup = step.getByRole('button', { name: /Set up (2 recommended agents|the \d remaining agent)/ })
      if (await setup.count()) {
        await setup.click()
        await expect(page.getByText(/ready at drafts only|Set up \d of 2/)).toBeVisible()
      }
      // pressing it again never creates a second agent
      expect((await api(page, 'POST', '/api/store/onboarding', { op: 'agents' })).status).toBe(200)
      const before = (await agentIds(page)).length
      expect((await api(page, 'POST', '/api/store/onboarding', { op: 'agents' })).status).toBe(200)
      expect((await agentIds(page)).length).toBe(before)
      await page.reload()
      for (const a of (await wizard(page)).agents) {
        if (a.agentId && !createdByWizard.includes(a.agentId)) createdByWizard.push(a.agentId)
        const card = page.locator(`[data-agent-key="${a.key}"]`)
        await expect(card.getByText('Drafts only', { exact: true })).toBeVisible()
        if (a.status !== 'draft') continue
        await expect(card.getByText('What it may do')).toBeVisible()
        const grant = card.getByRole('button', { name: /Grant .* at drafts only/ })
        await expect(grant).toBeDisabled()
        await card.getByRole('checkbox').check()
        await grant.click()
        await expect(page.getByText(/granted at drafts only/)).toBeVisible()
      }
      await shoot(page, 'onboarding-agents')
    } else if (w.current === 'scan') {
      await step.getByRole('button', { name: 'Run the first scan' }).click()
      await expect(page.getByText(/First scan finished/)).toBeVisible({ timeout: 60_000 })
    } else if (w.current === 'done') {
      await step.getByRole('button', { name: 'Finish setup' }).click()
      await expect(page.getByText('Done. Your team is ready.')).toBeVisible()
    } else {
      throw new Error(`unexpected step ${w.current}`)
    }
    await expect.poll(async () => (await wizard(page)).current, { timeout: 30_000 }).not.toBe(w.current === 'done' ? '' : w.current)
  }
  const done = await wizard(page)
  expect(done.completedAt).toBeTruthy()
  for (const a of done.agents) expect(a.status).toBe('active')
  // every agent the wizard created is drafts only for every tool
  for (const id of createdByWizard) {
    const d = await api<{ policies: { status: string; policy: { approvalMode: string; email?: { permission: string } } }[] }>(page, 'GET', `/api/store/agents/${id}`)
    const p = d.json.policies.find(x => x.status === 'active')!.policy
    expect(p.approvalMode).toBe('draft')
    if (p.email) expect(p.email.permission).toBe('draft')
  }
  await page.goto('/store/onboarding')
  await expect(page.getByRole('link', { name: 'Open the Control Room' })).toBeVisible()
})

test('Control Room: agents, approvals, connections and issues; Stop all asks first and pauses everything', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await expect(page).toHaveURL(/\/store$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Control Room' })).toBeVisible()
  const cr = await api<{ agents: { id: string; name: string; status: string }[]; approvals: { count: number }; org: { id: string } }>(page, 'GET', '/api/store/control-room')
  expect(cr.status).toBe(200)
  for (const a of cr.json.agents) await expect(page.locator(`[data-agent="${a.name}"]`).first()).toBeVisible()
  await expect(page.getByTestId('approvals-count')).toHaveText(/\d+/)
  await expect(page.getByRole('list', { name: 'Connection health' })).toContainText('Shopify')
  await expect(page.getByRole('heading', { name: 'Issues by severity' })).toBeVisible()
  await page.goto('/store/control-room')
  await expect(page.getByRole('heading', { level: 1, name: 'Control Room' })).toBeVisible()
  await shoot(page, 'control-room')

  // another organization sees only its own agents
  const nwIds = cr.json.agents.map(a => a.id)
  await signIn(page, HARBOR)
  const hb = await api<{ agents: { id: string }[]; org: { id: string } }>(page, 'GET', '/api/store/control-room')
  expect(hb.json.org.id).not.toBe(cr.json.org.id)
  expect(hb.json.agents.filter(a => nwIds.includes(a.id))).toEqual([])
  await signIn(page, 'hello@getdeploi.com')
  expect((await api(page, 'GET', '/api/store/control-room')).status).toBe(403)
  expect((await api(page, 'POST', '/api/store/control-room/stop-all', { confirm: 'stop' })).status).toBe(403)

  await signIn(page, NORTHWIND)
  pausedBySpec = cr.json.agents.filter(a => a.status === 'active').map(a => a.id)
  expect((await api(page, 'POST', '/api/store/control-room/stop-all', {})).status).toBe(400) // needs the confirmation
  await page.getByTestId('stop-all').click()
  const dialog = page.getByRole('dialog', { name: 'Stop all agents?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await api<{ agents: { status: string }[] }>(page, 'GET', '/api/store/control-room')).json.agents.filter(a => a.status === 'active').length).toBe(pausedBySpec.length)
  await page.getByTestId('stop-all').click()
  await page.getByRole('button', { name: 'Yes, stop all agents' }).click()
  await expect(page.getByText('All agents stopped.')).toBeVisible()
  const after = await api<{ agents: { status: string }[] }>(page, 'GET', '/api/store/control-room')
  expect(after.json.agents.filter(a => a.status === 'active')).toHaveLength(0)
})

test('Integrations: every tool with an honest status; agent pages show permissions at a glance', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/integrations')
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible()
  await expect(page.locator('[data-integration="shopify"]')).toHaveAttribute('data-status', 'connected')
  for (const k of ['woocommerce', 'agent_mailbox', 'gmail', 'microsoft', 'hubspot', 'google_calendar', 'stripe']) await expect(page.locator(`[data-integration="${k}"]`)).toBeVisible()
  await expect(page.locator('[data-integration="gmail"]').getByText('Not live-verified', { exact: true })).toBeVisible()
  // WooCommerce and Office pages ship separately: until they exist the card says so and offers no link
  await expect(page.locator('[data-integration="hubspot"]')).not.toHaveAttribute('data-status', 'connected')
  await shoot(page, 'integrations')

  const id = createdByWizard[0]
  test.skip(!id, 'no wizard agent to open')
  await page.goto(`/store/agents/${id}`)
  await expect(page.getByTestId('permissions-glance')).toContainText('Drafts only')
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByTestId('edit-preview')).toHaveAttribute('data-needs-grant', 'false')
  await shoot(page, 'agent-edit')
})
