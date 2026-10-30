/**
 * Agent email end to end with the synthetic mailbox (nothing is ever emailed; dev auth, seed applied):
 * connect a synthetic mailbox through the provider-style consent flow; create an email-only agent in
 * the wizard (supplier restock requests and run summaries, send what you approve) and grant it; run it;
 * the exact sender, recipients and body are shown for approval; editing the subject and approving ends
 * "Accepted by provider"; another organization cannot see the messages and staff cannot approve;
 * disconnecting the account cancels what was still waiting. Synthetic email state, the store and its
 * engine history are reset first so the spec is repeatable.
 * Set E2E_SCREENS_DIR to also save screenshots.
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

test.describe.configure({ mode: 'serial' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const NORTHWIND = 'owner@northwind-goods.example'
const HARBOR = 'owner@harbor-supply.example'
const STAFF = 'hello@getdeploi.com'
const MAILBOX = 'agent@northwind-goods.example'
const SUPPLIER = 'orders@supplier.example'
const AGENT = 'E2E Supplier Mail'
const SCREENS = process.env.E2E_SCREENS_DIR

type Agent = { id: string; name: string; status: string }
type Msg = { id: string; status: string; task_key: string; content_hash: string; to_addresses: string[]; subject: string | null }

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.request.fetch(path, { method, data: body === undefined ? undefined : body, headers: { origin: BASE, 'content-type': 'application/json' } })
  return { status: res.status(), json: (await res.json()) as T }
}

async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  if (!SCREENS) return
  const file = path.join(SCREENS, `email-${name}.png`)
  if (target) await target.screenshot({ path: file })
  else await page.screenshot({ path: file, fullPage: true })
}

async function messages(page: Page, agentId: string): Promise<Msg[]> {
  const r = await api<{ messages: Msg[] }>(page, 'GET', `/api/store/email/messages?agent=${agentId}`)
  expect(r.status).toBe(200)
  return r.json.messages
}

let agentId = ''
let supplierMsgId = ''
let reportMsgId = ''

test('connect a synthetic mailbox from Connections', async ({ page }) => {
  await signIn(page, NORTHWIND)
  // clean slate: our agent, the synthetic mailbox and its messages, the store and its history
  for (const a of (await api<{ agents: Agent[] }>(page, 'GET', '/api/store/agents')).json.agents.filter(x => x.name === AGENT)) {
    expect((await api(page, 'DELETE', `/api/store/agents/${a.id}`)).status).toBe(200)
  }
  const conn = (await api<{ connections: { id: string }[] }>(page, 'GET', '/api/store/overview')).json.connections[0].id
  expect((await api(page, 'POST', '/api/store/demo', { action: 'reset', connectionId: conn, clearHistory: true, clearEmail: true })).status).toBe(200)

  await page.goto('/store/connections')
  await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible()
  await expect(page.getByText(/Deploi never asks for your mailbox password/)).toBeVisible()
  await expect(page.getByText('Synthetic mailbox: test only, nothing is ever emailed')).toBeVisible()
  await expect(page.getByText('No email account connected.')).toBeVisible()

  await page.getByRole('button', { name: /^Connect Synthetic mailbox/ }).click()
  await page.waitForURL(/\/api\/email\/oauth\/synthetic/)
  await page.locator('input[name=address]').fill(MAILBOX)
  for (const box of await page.locator('input[type=checkbox]').all()) await box.check()
  await page.getByRole('button', { name: 'Allow' }).click()
  await page.waitForURL(/\/store\/connections/)
  await expect(page.getByText(/Email account connected/)).toBeVisible()

  const card = page.locator('#email li').filter({ hasText: MAILBOX })
  await expect(card).toBeVisible()
  await expect(card.locator('.badge', { hasText: /^Connected$/ })).toBeVisible()
  await expect(card.getByText('Granted').first()).toBeVisible()
  await expect(card.getByRole('button', { name: `Check connection for ${MAILBOX}` })).toBeVisible()
  await card.getByRole('button', { name: `Check connection for ${MAILBOX}` }).click()
  await expect(page.getByText(/the provider accepted the check\. Nothing was sent\./)).toBeVisible()
  await shot(page, 'connections')
})

test('create an email-only agent in the wizard, grant it, and run it', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/agents/new')
  await page.getByLabel('Agent name').fill(AGENT)
  await page.getByLabel('Task, in plain English').fill(`Email our supplier ${SUPPLIER} when products run low, and email me a summary of each run. Ask me before sending.`)
  await page.getByRole('button', { name: 'Draft it' }).click()
  await expect(page.getByRole('heading', { name: 'Review the structured task' })).toBeVisible()

  // prefilled from the text: email on, both tasks; the permission stays drafts only (the default) and the
  // text's "ask me before sending" is shown as a suggestion the merchant must choose; the address is only a suggestion
  await expect(page.getByRole('checkbox', { name: 'Let this agent use email' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /^Ask a supplier to confirm restock/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /^Send a summary of each run/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: /^Create drafts for review/ })).toBeChecked()
  await expect(page.getByText(/Your task asked for: send messages you approve one by one/)).toBeVisible()
  await page.getByRole('radio', { name: /^Send messages you approve one by one/ }).check()
  await expect(page.getByText('found in your text: confirm').last()).toBeVisible()

  await page.getByLabel('Send from').selectOption({ label: `${MAILBOX} · Synthetic mailbox (test only)` })
  await page.getByLabel('Purpose', { exact: true }).fill('Restock requests to our supplier and run summaries for the owner')
  await page.getByLabel('Allowed recipient addresses').fill(`${NORTHWIND}`)
  await page.getByLabel('Allowed recipient domains').fill('supplier.example')
  await page.getByLabel('Send summaries and alerts to').fill('someone@elsewhere.example')
  await expect(page.getByText(/Outside the recipient rules: someone@elsewhere.example/)).toBeVisible()
  await page.getByLabel('Send summaries and alerts to').fill(NORTHWIND)
  await page.getByLabel('Supplier address').fill(SUPPLIER)
  await page.getByRole('checkbox', { name: /^Allow attachments/ }).check()
  await page.getByRole('radio', { name: 'All products in the store' }).check()
  await expect(page.getByRole('checkbox', { name: /^Notice supplier replies/ })).toBeDisabled() // no read access granted
  // email-only: no correction types and no store-change approval mode needed
  await expect(page.getByRole('heading', { name: /How changes are approved/ })).toHaveCount(0)
  await shot(page, 'agent-form', page.locator('section#review'))

  await page.getByRole('button', { name: 'Review authorization' }).click()
  await expect(page.getByRole('heading', { name: 'Review the authorization' })).toBeVisible()
  await expect(page.getByText(new RegExp(`Email from ${MAILBOX}: may send a message only after you approve that exact message`))).toBeVisible()
  await expect(page.getByText(/Email recipients allowed: owner@northwind-goods.example, anyone @supplier.example/)).toBeVisible()
  await expect(page.getByText('Never sends email to anyone outside the allowed recipients without your approval of that exact message.')).toBeVisible()
  await expect(page.getByText('Never reads your mailbox.')).toBeVisible()

  await page.getByRole('button', { name: 'Grant this authorization' }).click()
  await expect(page.getByText('Authorization granted.')).toBeVisible()
  await page.getByRole('link', { name: /Open agent/ }).click()
  await page.waitForURL(/\/store\/agents\/[0-9a-f-]+$/)
  agentId = page.url().split('/').pop()!
  await expect(page.locator('#email')).toContainText(MAILBOX)
  await expect(page.locator('#email')).toContainText('Send messages you approve one by one')

  await page.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByText('Run finished.')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/emails? awaiting approval/).first()).toBeVisible()

  const list = await messages(page, agentId)
  supplierMsgId = list.find(m => m.task_key === 'supplier_reorder')?.id ?? ''
  reportMsgId = list.find(m => m.task_key === 'run_report')?.id ?? ''
  expect(supplierMsgId).not.toBe('')
  expect(reportMsgId).not.toBe('')
  expect(list.every(m => m.status === 'awaiting_approval')).toBe(true)
})

test('review the exact message, edit it, approve it: Accepted by provider', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto(`/store/agents/${agentId}`)
  const card = page.locator('#email-waiting li').filter({ hasText: SUPPLIER })
  await expect(card).toBeVisible()
  await expect(card.getByText(MAILBOX)).toBeVisible() // exact sender
  await expect(card.getByText(SUPPLIER)).toBeVisible() // exact recipient
  await expect(card.getByLabel('Message body')).toContainText('would like to restock the products below')
  await expect(card.getByLabel('Message body')).toContainText(`Deploi agent "${AGENT}"`)
  await expect(card.getByText('restock-request.csv')).toBeVisible()
  await expect(card.getByLabel('Preview of restock-request.csv')).toContainText('sku,product,available')
  await expect(card.getByText(/Why it waits:/)).toBeVisible()
  await shot(page, 'awaiting', card)

  await card.getByRole('button', { name: `Edit message to ${SUPPLIER}` }).click()
  await expect(card.getByText(/needs your approval again; any earlier approval no longer applies/)).toBeVisible()
  await card.getByLabel('Subject').fill('Restock request from Northwind Goods (edited)')
  await card.getByRole('button', { name: 'Save edit' }).click()
  await expect(page.getByText(/This edited version now needs your approval/)).toBeVisible()
  await expect(card.getByText('Restock request from Northwind Goods (edited)')).toBeVisible()

  await card.getByRole('button', { name: `Approve and send to ${SUPPLIER}` }).click()
  await expect(page.locator('#email-waiting').getByText('Accepted by provider.')).toBeVisible({ timeout: 60_000 })
  const sent = page.locator('#email-sent li').filter({ hasText: 'Restock request from Northwind Goods (edited)' })
  await expect(sent.locator('.badge', { hasText: /^Accepted by provider$/ })).toBeVisible()
  await expect(sent.getByText(/Approved by you/)).toBeVisible()
  await expect(sent.getByText('The provider accepted it for delivery. Deploi cannot confirm it reached the inbox.')).toBeVisible()
  await expect(page.getByText(/Delivered|Sent successfully/)).toHaveCount(0)
  // the run summary is still waiting
  await expect(page.locator('#email-waiting li').filter({ hasText: 'Run summary' })).toBeVisible()
  await shot(page, 'sent', page.locator('#email-sent'))
})

test('another organization cannot see Northwind messages; staff cannot approve', async ({ page }) => {
  await signIn(page, HARBOR)
  expect((await api(page, 'GET', `/api/store/email/messages/${supplierMsgId}`)).status).toBe(404)
  const list = await api<{ messages: Msg[] }>(page, 'GET', '/api/store/email/messages')
  expect(list.status).toBe(200)
  expect(list.json.messages.some(m => m.id === supplierMsgId || m.id === reportMsgId)).toBe(false)
  expect((await api(page, 'GET', `/api/store/email/messages?agent=${agentId}`)).json).toMatchObject({ messages: [] })
  expect((await api(page, 'POST', `/api/store/email/messages/${reportMsgId}/decline`, {})).status).toBe(404)

  await signIn(page, NORTHWIND)
  const report = (await messages(page, agentId)).find(m => m.id === reportMsgId)!
  await signIn(page, STAFF)
  const approve = await api<{ error: string }>(page, 'POST', `/api/store/email/messages/${reportMsgId}/approve`, { contentHash: report.content_hash })
  expect(approve.status).toBe(403)
  expect(approve.json.error).toBe('forbidden')
  // staff see no message content
  const staffView = await api<{ message: { content: unknown } }>(page, 'GET', `/api/store/email/messages/${reportMsgId}`)
  expect(staffView.status).toBe(200)
  expect(staffView.json.message.content).toBeNull()
})

test('disconnecting the account cancels what was still waiting', async ({ page }) => {
  await signIn(page, NORTHWIND)
  await page.goto('/store/connections')
  const card = page.locator('#email li').filter({ hasText: MAILBOX })
  await expect(card.getByText('1 agent')).toBeVisible()
  await card.getByRole('button', { name: `Disconnect ${MAILBOX}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Disconnect this email account?' })
  await expect(dialog.getByText(/cancels every unsent message from it/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Disconnect account' }).click()
  await expect(page.getByText(/disconnected and its tokens deleted\. 1 unsent message was cancelled\./)).toBeVisible()
  await expect(page.locator('#email li').filter({ hasText: MAILBOX })).toHaveCount(0)

  const after = await messages(page, agentId)
  expect(after.find(m => m.id === reportMsgId)?.status).toBe('cancelled')
  expect(after.find(m => m.id === supplierMsgId)?.status).toBe('accepted')
  expect(after.filter(m => ['draft', 'awaiting_approval', 'queued'].includes(m.status))).toHaveLength(0)

  await page.goto(`/store/agents/${agentId}`)
  await expect(page.locator('#email-waiting').getByText('Nothing waiting')).toBeVisible()
  const cancelled = page.locator('#email-sent li').filter({ hasText: 'Run summary' })
  await expect(cancelled.locator('.badge', { hasText: /^Cancelled$/ })).toBeVisible()
  await expect(cancelled.getByText('the email account was disconnected')).toBeVisible()
  await shot(page, 'sent-statuses', page.locator('#email-sent'))

  // leave nothing running for the other specs
  expect((await api(page, 'DELETE', `/api/store/agents/${agentId}`)).status).toBe(200)
})
