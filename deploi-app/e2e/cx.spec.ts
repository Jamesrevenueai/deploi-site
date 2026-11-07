/**
 * Customer experience end to end (synthetic Northwind store, dev auth, DEMO_CONTROLS=true):
 * the one setup path (/store/setup) walks business → agreements (off here) → products → connect → find the work
 * (discovery, the recommended team set up at drafts only and granted explicitly) → done, and resumes wherever it
 * was left; setting the team up again never duplicates an agent. The old URL /store/onboarding redirects. The Command center shows the team, what needs
 * the owner and the connected store; Stop all agents asks first and pauses every agent; Integrations shows honest statuses.
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
  // the Control Room spec turns the organization stop on; turn it off before resuming what it paused
  await api(page, 'POST', '/api/store/control-room/stop-all', { action: 'clear' })
  for (const id of pausedBySpec) await api(page, 'POST', `/api/store/agents/${id}/resume`, {})
  for (const id of createdByWizard) await api(page, 'DELETE', `/api/store/agents/${id}`)
  await page.close()
})

test('setup: from the first step to done, the discovered team at drafts only and granted by the owner', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/onboarding')
  await expect(page).toHaveURL(/\/store\/setup$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Deploi' })).toBeVisible()
  await expect(page.locator('[data-step="connect"][data-state="done"]')).toBeVisible()
  await expect(page.locator('[data-step="agreements"][data-raw-state="skipped"]')).toBeVisible()
  for (let guard = 0; guard < 10; guard++) {
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
      // the platform radio of this step (the business-type picker below the wizard also mentions Shopify)
      await step.getByRole('group', { name: 'Your store platform' }).getByRole('radio', { name: 'Shopify', exact: true }).check()
      await step.getByRole('button', { name: 'Save and continue' }).click()
    } else if (w.current === 'discover') {
      const run = step.getByRole('button', { name: /Discover my business|Run discovery again/ })
      await run.click()
      await expect(step.getByRole('heading', { name: 'We found work your AI team can handle.' })).toBeVisible({ timeout: 60_000 })
      const existing = new Set((await agentIds(page)).map(a => a.id))
      const setUp = step.getByRole('button', { name: 'Set up recommended team' })
      if (await setUp.count()) await setUp.click()
      const grant = step.getByRole('button', { name: /Grant all shown/ })
      // drafts now wait for the owner's grant, or the recommended agents were already working (the step completes)
      await expect(grant.or(page.locator('[data-step="discover"][data-state="done"]'))).toBeVisible()
      // setting up again never creates a second agent
      const before = (await agentIds(page)).length
      expect((await api(page, 'POST', '/api/store/discover/team', { op: 'create' })).status).toBe(200)
      expect((await agentIds(page)).length).toBe(before)
      // only agents this spec created are removed afterwards (an existing agent the team setup linked to is kept)
      for (const a of await agentIds(page)) if (!existing.has(a.id) && !createdByWizard.includes(a.id)) createdByWizard.push(a.id)
      await shoot(page, 'onboarding-agents')
      if (await grant.count()) {
        await grant.click()
        await expect(page.getByText(/(now working, at drafts only|\d+ agents? working at drafts only)/).first()).toBeVisible()
      }
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
  // every engine agent the team setup created is granted, and drafts only for every tool
  for (const id of createdByWizard) {
    const d = await api<{ policies: { status: string; policy: { approvalMode: string; email?: { permission: string } } }[] }>(page, 'GET', `/api/store/agents/${id}`)
    if (d.status !== 200) continue
    const p = d.json.policies.find(x => x.status === 'active')!.policy
    expect(p.approvalMode).toBe('draft')
    if (p.email) expect(p.email.permission).toBe('draft')
  }
  await page.goto('/store/setup')
  await expect(page.getByRole('link', { name: 'Go to the Command center' })).toBeVisible()
})

test('the Command center: the team, what needs you and the connected store; Stop all asks first and pauses everything', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await expect(page).toHaveURL(/\/store$/)
  await expect(page.getByRole('heading', { level: 1, name: /Your team is on it\.$/ })).toBeVisible()
  const cr = await api<{ agents: { id: string; name: string; status: string }[]; approvals: { count: number }; org: { id: string } }>(page, 'GET', '/api/store/control-room')
  expect(cr.status).toBe(200)
  const cc = await api<{ workspace: string; team: { id: string; name: string }[]; needsYou: unknown[] }>(page, 'GET', '/api/app/command-center')
  expect(cc.status).toBe(200)
  await expect(page.getByTestId('team-row')).toHaveCount(cc.json.team.length)
  // each row opens its own agent (two agents may share a name, e.g. a library agent and an engine agent the setup created)
  for (const [i, a] of cc.json.team.entries()) await expect(page.getByTestId('team-row').nth(i).getByRole('link', { name: `Open ${a.name}`, exact: true })).toHaveAttribute('href', `/agents/${encodeURIComponent(a.id)}`)
  await expect(page.getByTestId('needs-you-card')).toHaveCount(cc.json.needsYou.length)
  await expect(page.getByTestId('workspace-name')).toContainText('Shopify')
  // the old Control Room URL still works: it redirects to the Command center
  await page.goto('/store/control-room')
  await expect(page).toHaveURL(/\/store$/)
  await expect(page.getByTestId('command-center')).toBeVisible()
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
  await expect(page.getByText('All agents are stopped.')).toBeVisible()
  const after = await api<{ agents: { status: string }[]; orgStop: unknown }>(page, 'GET', '/api/store/control-room')
  expect(after.json.agents.filter(a => a.status === 'active')).toHaveLength(0)
  expect(after.json.orgStop).not.toBeNull()
  // the organization stop holds until the owner turns it off; resuming an agent is refused meanwhile
  await expect(page.getByTestId('org-stopped')).toBeVisible()
  if (pausedBySpec[0]) expect((await api(page, 'POST', `/api/store/agents/${pausedBySpec[0]}/resume`, {})).status).toBeGreaterThanOrEqual(400)
  await page.getByTestId('clear-stop').click()
  await expect(page.getByTestId('org-stopped')).toHaveCount(0)
  expect((await api<{ orgStop: unknown }>(page, 'GET', '/api/store/control-room')).json.orgStop).toBeNull()
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
