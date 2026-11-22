/**
 * Account lifecycle end to end (dev auth, DEMO_CONTROLS=true, EMAIL_LIVE_SENDS off so invitations are held and
 * their link is shown to the inviter):
 *  1. The Northwind owner invites a new address as admin from Settings → Members; another person opening the
 *     link is refused; the invited person signs up through the link, joins Northwind as admin and lands in the
 *     store; the link then refuses a second use. The owner revokes a second invitation and its link stops working.
 *  2. A brand-new sign-up: create an account → /start creates their own organization (owner) → setup: products
 *     (Office) → connect synthetic QuickBooks and a mailbox → discovery ("We found work your AI team can
 *     handle.") → set up the team → grant → an Accounts Receivable agent working at drafts only → finish.
 *  3. Get help from the help menu creates a support request that the customer sees in their own support view.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const RUN = Date.now().toString(36)

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.getByRole('button', { name: 'Sign in', exact: true }).click()])
}
async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as T }
}
type Members = { members: { userId: string; email: string; role: string }[]; invites: { id: string; email: string }[]; yourRole: string }

const invited = `new.admin.${RUN}@e2e-invite.example`
const joined: string[] = []

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE })
  await signIn(page, NORTHWIND)
  const m = (await api<Members>(page, 'GET', '/api/store/settings/members')).json
  for (const x of m.members) if (joined.includes(x.email)) await api(page, 'POST', '/api/store/settings/members', { action: 'remove', userId: x.userId })
  for (const i of m.invites) if (i.email.endsWith('@e2e-invite.example')) await api(page, 'POST', '/api/store/settings/members', { action: 'revoke_invite', inviteId: i.id })
  await page.close()
})

test('invite → accept as a new user → lands in the organization with the invited role', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/settings')
  const members = page.getByTestId('members')
  await expect(members.locator(`[data-member="${NORTHWIND}"]`)).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(invited)
  await page.getByLabel('Role', { exact: true }).selectOption('admin')
  await page.getByRole('button', { name: 'Send invitation' }).click()
  // email is off in this environment: the invitation is recorded and its link shown to share
  const linkEl = page.getByTestId('invite-link')
  await expect(linkEl).toBeVisible()
  const link = new URL((await linkEl.textContent())!.trim())
  await expect(members.locator(`[data-invite="${invited}"]`)).toContainText('admin')
  await page.screenshot({ path: 'proof/account-members-1440.png', fullPage: true })

  // someone else signed in cannot use it
  await signIn(page, HARBOR)
  await page.goto(link.pathname)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Join')
  await expect(page.getByText(/this invitation is for/i).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Join / })).toHaveCount(0)

  // the invited person: signed out, opens the link, signs up as the invited address, joins
  await page.request.post('/logout')
  await page.goto(link.pathname)
  await expect(page.getByTestId('invite-role')).toHaveText('admin')
  await page.getByRole('button', { name: `Continue as ${invited}` }).click()
  await page.getByRole('button', { name: /^Join .* as admin$/ }).click()
  await page.waitForURL(u => u.pathname === '/store')
  joined.push(invited)
  await expect(page.getByRole('heading', { level: 1, name: /Your team is on it\.$/ })).toBeVisible()
  const me = (await api<Members>(page, 'GET', '/api/store/settings/members')).json
  expect(me.yourRole).toBe('admin')
  expect(me.members.find(m => m.email === invited)?.role).toBe('admin')
  expect(me.invites.find(i => i.email === invited)).toBeUndefined()

  // the link worked once
  await page.goto(link.pathname)
  await expect(page.getByRole('heading', { level: 1, name: 'This invitation was already used' })).toBeVisible()

  // a revoked invitation's link stops working at once
  await signIn(page, NORTHWIND)
  const second = await api<{ inviteId: string; link: string }>(page, 'POST', '/api/store/settings/members', { action: 'invite', email: `revoked.${RUN}@e2e-invite.example`, role: 'viewer' })
  expect(second.status).toBe(200)
  await page.goto('/store/settings')
  await page.locator(`[data-invite="revoked.${RUN}@e2e-invite.example"]`).getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText(/its link no longer works/)).toBeVisible()
  await page.goto(new URL(second.json.link).pathname)
  await expect(page.getByRole('heading', { level: 1, name: 'This invitation was withdrawn' })).toBeVisible()
})

test('a new sign-up: own organization as owner, then products, connect, discovery and the team at drafts only', async ({ page }) => {
  const email = `founder.${RUN}@e2e-signup.example`
  await page.request.post('/logout')
  await page.goto('/login')
  await page.getByLabel('New account email').fill(email)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(u => u.pathname === '/start')
  // no organization yet: the store is not reachable, it sends you back here
  await page.goto('/store')
  await page.waitForURL(u => u.pathname === '/start')
  await page.getByLabel('Business name').fill(`Founder Goods ${RUN}`)
  await page.getByRole('button', { name: 'Create my business' }).click()
  await page.waitForURL(u => u.pathname === '/store/setup')
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Deploi' })).toBeVisible()
  const me = (await api<Members>(page, 'GET', '/api/store/settings/members')).json
  expect(me.yourRole).toBe('owner')
  expect(me.members.map(m => m.email)).toEqual([email])

  // business is done (named at /start); agreements are not required here
  await expect(page.locator('[data-step="business"][data-state="done"]')).toBeVisible()
  await expect(page.locator('[data-step="products"][data-raw-state="current"]')).toBeVisible()
  await page.getByLabel(/Deploi Commerce/).uncheck()
  await page.getByLabel(/Deploi Office/).check()
  await page.locator('[data-step="products"]').getByRole('button', { name: 'Save and continue' }).click()

  // connect an app: synthetic QuickBooks and a synthetic mailbox (test only)
  const connect = page.locator('[data-step="connect"]')
  await expect(connect).toHaveAttribute('data-raw-state', 'current')
  await connect.getByRole('link', { name: /Connect HubSpot, Google Calendar, QuickBooks or a mailbox/ }).click()
  await page.waitForURL(u => u.pathname === '/office/connections')
  await expect(page.getByText(/continue setup/)).toBeVisible()
  const qbo = page.locator('div').filter({ has: page.getByRole('heading', { name: 'QuickBooks Online', exact: false }) }).filter({ has: page.getByRole('button', { name: 'Use a synthetic one (test)' }) }).last()
  await qbo.getByRole('button', { name: 'Use a synthetic one (test)' }).click()
  await expect(page.getByText(/Synthetic QuickBooks/)).toBeVisible()
  await page.getByRole('button', { name: 'Add a synthetic mailbox (test)' }).click()
  await expect(page.getByText(/Synthetic/, { exact: true }).first()).toBeVisible()
  await page.getByRole('link', { name: 'continue setup' }).click()
  await page.waitForURL(u => u.pathname === '/store/setup')

  // discovery: we found work; set up the team at drafts only; grant what is shown
  const step = page.locator('[data-step="discover"]')
  await expect(step).toHaveAttribute('data-raw-state', 'current')
  await step.getByRole('button', { name: 'Discover my business' }).click()
  await expect(step.getByRole('heading', { name: 'We found work your AI team can handle.' })).toBeVisible({ timeout: 60_000 })
  await expect(step.getByTestId('team')).toContainText('Accounts Receivable')
  await step.getByRole('button', { name: 'Set up recommended team' }).click()
  const grant = step.getByRole('button', { name: /Grant all shown/ })
  await expect(grant).toBeVisible()
  await expect(step.getByTestId('policy-summary').first()).toBeVisible()
  await page.screenshot({ path: 'proof/account-first-run-1440.png', fullPage: true })
  await grant.click()
  // the step closes once the team is granted; its summary (or the flow's note while it is still open) says so
  await expect(page.getByText(/(now working, at drafts only|\d+ agents? working at drafts only)/).first()).toBeVisible()

  type Team = { template: string; agent: { agentKind: string; agentId: string; status: string; summary: { grants: string[] } | null } | null }[]
  const team = (await api<{ team: Team }>(page, 'GET', '/api/store/discover')).json.team
  const ar = team.find(t => t.template === 'accounts_receivable')!
  expect(ar.agent).toMatchObject({ agentKind: 'office', status: 'active' })
  const agents = (await api<{ agents: { id: string; kind: string; status: string; active_policy: { email: { tier: string } } }[] }>(page, 'GET', '/api/office/agents')).json.agents
  const a = agents.find(x => x.id === ar.agent!.agentId)!
  expect(a).toMatchObject({ kind: 'accounts_receivable', status: 'active' })
  // granted, and still drafts only: it drafts reminders and sends none
  expect(a.active_policy.email.tier).toBe('draft')

  // finish: one path, no dead end
  await expect(page.locator('[data-step="done"][data-raw-state="current"]')).toBeVisible()
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(page.getByText('Done. Your team is ready.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Go to the Command center' })).toBeVisible()
})

test('Get help from the help menu: the request is in the customer\'s own support view', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/work')
  await page.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Get help' }).click()
  await page.getByLabel('What is it about?').selectOption('question')
  await page.getByLabel('How can we help?').fill(`e2e ${RUN}: how do I add a teammate?`)
  await page.getByRole('button', { name: 'Send to Deploi support' }).click()
  await expect(page.getByTestId('help-sent')).toContainText(/SUP-[0-9A-F]{8}/)
  await page.getByTestId('help-sent').getByRole('link', { name: 'your support requests' }).click()
  await page.waitForURL(u => u.pathname === '/store/support')
  await expect(page.getByRole('heading', { level: 1, name: 'Support requests' })).toBeVisible()
  await expect(page.getByTestId('support-thread')).toContainText(`e2e ${RUN}: how do I add a teammate?`)
  // another organization does not see it
  await signIn(page, HARBOR)
  const theirs = (await api<{ tickets: { subject: string }[] }>(page, 'GET', '/api/store/support')).json.tickets
  expect(theirs.some(t => t.subject.includes(RUN))).toBe(false)
})
