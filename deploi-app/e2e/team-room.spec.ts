/**
 * The 2026-11-07 additions in a real browser (local production build, dev auth, AI_PROVIDER=off, the seeded
 * synthetic Northwind store; same recipe as e2e/agent-dashboard.spec.ts):
 *   - Deploi reads the business (discovery) and the Command center shows "What your team learned" from that read;
 *   - the sidebar lists the business's own sections (one per pack that is on) and the Team room;
 *   - giving an agent a task from its page: the agent answers, the task is listed, then marked done;
 *   - the team room shows the task from you to the agent, the agent picking it up and you closing it; a task given
 *     from the room's own box ("<agent>, please ...");
 *   - no horizontal page scroll at 390.
 * Screenshots: proof/redesign/after-local/{team-room,agent-task,command-center-learned}-1440.png and -390.png.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
test.use({ deviceScaleFactor: 1 })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const OWNER = 'owner@northwind-goods.example'
const ID = 'store:inventory_watcher'
const DIR = 'proof/redesign/after-local'

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
    await page.waitForTimeout(300)
    if (w === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} overflows at 390`).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `${DIR}/${name}-${tag}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
const errors: string[] = []
test.beforeEach(async ({ page }) => {
  page.on('pageerror', e => errors.push(e.message))
  await signIn(page, OWNER)
  expect((await api(page, 'POST', '/api/app/workspace', { workspace: 'store' })).status).toBe(200)
})
test.afterAll(() => { expect(errors, 'page errors').toEqual([]) })

test('Deploi reads the business; the Command center shows what it learned; the sidebar lists the business sections', async ({ page }) => {
  test.setTimeout(180_000)
  const d = await api(page, 'POST', '/api/store/discover', {})
  expect(d.status, JSON.stringify(d.json).slice(0, 300)).toBeLessThan(300)
  const l = (await api(page, 'GET', '/api/app/learned')).json as { learned: { read: string[]; facts: unknown[]; seconds: number } | null }
  expect(l.learned).not.toBeNull()
  expect(l.learned!.seconds).toBeLessThan(60)
  await page.goto('/store')
  const card = page.getByTestId('learned')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('learned-line')).toContainText(/^Read .+ in (under a second|\d+ seconds?):/)
  if (l.learned!.facts.length) await expect(card.getByRole('list', { name: 'What it read' }).getByRole('listitem')).toHaveCount(l.learned!.facts.length)
  const sections = page.getByTestId('business-sections')
  await expect(sections).toBeVisible()
  await expect(sections.getByRole('link').first()).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Team room' })).toBeVisible()
  await pair(page, 'command-center-learned')
})

test('giving an agent a task from its page: it answers honestly, the task is listed, then marked done', async ({ page }) => {
  test.setTimeout(120_000)
  // other specs may have switched it off or paused it: switch it on and resume it first
  expect((await api(page, 'POST', '/api/store/library/inventory_watcher/switch', { enabled: true })).status).toBe(200)
  expect((await api(page, 'POST', `/api/app/agents/${encodeURIComponent(ID)}/chat`, { text: 'resume' })).status).toBe(200)
  await page.goto(`/agents/${encodeURIComponent(ID)}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory Watcher' })).toBeVisible()
  const text = `Check stock on the blue mugs before Friday (${Date.now().toString(36)})`
  await page.getByTestId('task-input').fill(text)
  await page.getByRole('button', { name: 'Give task' }).click()
  await expect(page.getByTestId('task-reply')).toContainText(/^Task DC-\d{6}: Inventory Watcher: got it\./)
  const row = page.getByTestId('task-row').filter({ hasText: text })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Looking into it')
  await pair(page, 'agent-task')
  await row.getByRole('button', { name: `Mark done: ${text}` }).click()
  await expect(page.getByTestId('task-row').filter({ hasText: text })).toContainText('Done')
  await expect(page.getByTestId('task-row').filter({ hasText: text }).getByRole('button')).toHaveCount(0)
})

test('the team room: the task and its answers; a task given from the room box', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/store/room')
  await expect(page.getByRole('heading', { level: 1, name: 'Team room' })).toBeVisible()
  await expect(page.getByTestId('room-msg').filter({ hasText: 'Check stock on the blue mugs' }).first()).toBeVisible()
  for (const kind of ['task', 'picked_up', 'checked']) await expect(page.locator(`[data-testid=room-msg][data-kind=${kind}]`).first()).toBeVisible()
  const job = `Inventory Watcher, please recount the green bowls (${Date.now().toString(36)})`
  await page.getByLabel('Message the team').fill(job)
  await page.getByRole('button', { name: 'Send' }).click()
  // shown once, as the task from you to the agent, then the agent picking it up
  await expect(page.locator('[data-testid=room-msg][data-kind=task]').filter({ hasText: 'please recount the green bowls' })).toHaveCount(1)
  await expect(page.locator('[data-testid=room-msg][data-kind=picked_up]').filter({ hasText: 'recount the green bowls' })).toHaveCount(1)
  await expect(page.locator('[data-testid=room-msg][data-kind=chat]').filter({ hasText: 'recount the green bowls' })).toHaveCount(0)
  await pair(page, 'team-room')
})
