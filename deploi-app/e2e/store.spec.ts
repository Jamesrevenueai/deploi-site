/**
 * Merchant store end to end (synthetic Shopify store, dev auth, seed applied):
 * scan creates issues; approving a proposal ends Verified and the issue moves to Resolved; an
 * outside change between scan and approval ends Stale with no write; a refused write ends Failed
 * and a retry verifies; a second organization cannot open the first one's issue; staff cannot
 * approve. The demo store is reset first so the spec is repeatable.
 */
import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const STAFF = 'hello@getdeploi.com'

type Proposal = { id: string; status: string; change_hash: string }
type Issue = { id: string; status: string; kind: string; severity: string; resource_id: string; resource_label: string | null; proposal: Proposal | null; evidence: Record<string, unknown> }

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

/** Same-origin API call with the page's session cookie (mutations need an Origin header). */
async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json()) as T }
}

async function connectionId(page: Page): Promise<string> {
  const o = await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')
  expect(o.status).toBe(200)
  return o.json.connections[0].id
}

async function liveCorrectable(page: Page): Promise<Issue[]> {
  const r = await api<{ issues: Issue[] }>(page, 'GET', '/api/store/issues?status=live&kind=correctable')
  expect(r.status).toBe(200)
  return r.json.issues
}

/** Issues whose latest proposal is waiting for approval; issues held by the loop guard (from earlier runs) are re-proposed first. */
async function pendingIssues(page: Page): Promise<Issue[]> {
  for (const i of (await liveCorrectable(page)).filter(x => x.status === 'needs_review')) {
    expect((await api(page, 'POST', `/api/store/issues/${i.id}/repropose`, {})).status).toBe(200)
  }
  return (await liveCorrectable(page)).filter(i => i.status === 'open' && i.proposal?.status === 'pending_approval')
}

let northwindIssueId = ''
let pendingProposalId = ''

test('scan creates issues', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await expect(page).toHaveURL(/\/store$/)
  const conn = await connectionId(page)
  expect((await api(page, 'POST', '/api/store/demo', { action: 'reset', connectionId: conn })).status).toBe(200)

  await page.getByRole('button', { name: /Run scan/ }).click()
  await expect(page.getByText('Scan finished.')).toBeVisible({ timeout: 60_000 })

  await page.goto('/store/issues')
  await expect(page.getByRole('link', { name: /Selling with no stock against your rule/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Oversold while set to stop selling/ }).first()).toBeVisible()

  const pending = await pendingIssues(page)
  expect(pending.length).toBeGreaterThanOrEqual(3)
})

test('approving a proposal ends Verified and the issue moves to Resolved', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const pending = await pendingIssues(page)
  const target = pending.find(i => i.severity === 'high') ?? pending[0]
  northwindIssueId = target.id

  await page.goto(`/store/issues/${target.id}`)
  await expect(page.getByText('Continue selling when out of stock').first()).toBeVisible()
  await page.getByRole('button', { name: /Approve this change/ }).click()
  await expect(page.getByText('Verified: a fresh read shows the change')).toBeVisible({ timeout: 60_000 })

  await page.goto('/store/issues')
  await expect(page.locator(`a[href="/store/issues/${target.id}"]`)).toHaveCount(0)
  await page.getByRole('tab', { name: 'Resolved' }).click()
  const row = page.locator(`a[href="/store/issues/${target.id}"]`)
  await expect(row).toBeVisible()
  await expect(row.locator('.badge', { hasText: /^Verified$/ })).toBeVisible()
})

test('an outside change between scan and approval ends Stale with no write', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const conn = await connectionId(page)
  const target = (await pendingIssues(page))[0]
  expect(target).toBeTruthy()

  // the merchant (or another app) tags the product as pre-order after the scan
  await page.goto(`/store/issues/${target.id}`)
  await expect(page.getByRole('button', { name: /Approve this change/ })).toBeEnabled()
  const tags = Array.isArray(target.evidence.productTags) ? (target.evidence.productTags as string[]) : []
  expect((await api(page, 'POST', '/api/store/demo', { action: 'external_change', connectionId: conn, variantId: target.resource_id, tags: [...tags, 'preorder'] })).status).toBe(200)

  await page.getByRole('button', { name: /Approve this change/ }).click()
  await expect(page.getByText(/Not run: the store changed since this proposal/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Nothing was written.')).toBeVisible()

  const d = await api<{ executions: { status: string; applied_at: string | null; verified_at: string | null }[] }>(page, 'GET', `/api/store/issues/${target.id}`)
  expect(d.json.executions[0].status).toBe('stale')
  expect(d.json.executions[0].applied_at).toBeNull()

  await page.goto('/store/activity?outcome=blocked')
  await expect(page.getByText('Not run: records changed since approval').first()).toBeVisible()
})

test('a refused write ends Failed and a retry verifies', async ({ page }) => {
  await signIn(page, NORTHWIND)
  const conn = await connectionId(page)
  const target = (await pendingIssues(page))[0]
  expect(target).toBeTruthy()
  pendingProposalId = target.proposal!.id
  expect((await api(page, 'POST', '/api/store/demo', { action: 'fault', connectionId: conn, mode: 'user_error' })).status).toBe(200)

  await page.goto(`/store/issues/${target.id}`)
  await page.getByRole('button', { name: /Approve this change/ }).click()
  await expect(page.getByText(/^Failed/).first()).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Retry this change' }).first().click()
  await expect(page.getByText('Verified: a fresh read shows the change')).toBeVisible({ timeout: 60_000 })
})

test('a second organization cannot open the first organization\'s issue', async ({ page }) => {
  expect(northwindIssueId).not.toBe('')
  await signIn(page, HARBOR)
  await page.goto(`/store/issues/${northwindIssueId}`)
  await expect(page.getByText('Issue not found')).toBeVisible()
  expect((await api(page, 'GET', `/api/store/issues/${northwindIssueId}`)).status).toBe(404)
})

test('staff cannot approve: kept out of /store and refused by the API', async ({ page }) => {
  await signIn(page, STAFF)
  await page.goto('/store')
  await expect(page).not.toHaveURL(/\/store/)
  await page.goto(`/store/issues/${northwindIssueId}`)
  await expect(page).not.toHaveURL(/\/store/)

  // find a proposal still waiting (create one if needed) and try to approve it as staff
  await signIn(page, NORTHWIND)
  const p = (await pendingIssues(page))[0]?.proposal ?? null
  await signIn(page, STAFF)
  const r = await api<{ error: string }>(page, 'POST', `/api/store/proposals/${p?.id ?? pendingProposalId}/approve`, { changeHash: p?.change_hash ?? '0'.repeat(64) })
  expect([403, 409]).toContain(r.status)
  if (p) { expect(r.status).toBe(403); expect(r.json.error).toBe('forbidden') }
})
