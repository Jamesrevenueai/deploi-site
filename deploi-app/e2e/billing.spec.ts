/**
 * Billing end to end (production build, BILLING_MODE=test, dev auth) against a fake Stripe served from this
 * test process: the server's STRIPE_API_BASE points at http://127.0.0.1:<E2E_FAKE_STRIPE_PORT> (honoured in
 * test mode outside production only), Stripe's hosted Checkout page is stubbed in the browser, and Stripe's
 * events are signed with the server's webhook secret and posted to /api/billing/stripe/webhook.
 *
 * Run only when E2E_BILLING=1 (the server must be started with the billing env below); E2E_DATABASE_URL
 * names the e2e database, where a Stripe-billed organization and plan prices are set up.
 *   BILLING_MODE=test STRIPE_SECRET_KEY=<sk_test_ placeholder> STRIPE_WEBHOOK_SECRET=<E2E_STRIPE_WEBHOOK_SECRET>
 *   STRIPE_API_BASE=http://127.0.0.1:3517 STRIPE_PRICE_STARTER_MONTHLY=price_E2EStarter
 *   STRIPE_PRICE_GROWTH_MONTHLY=price_E2EGrowth STRIPE_PRICE_PRO_MONTHLY=price_E2EPro PLANS_CACHE_MS=0 STRIPE_MAX_RETRIES=0
 * Saves screenshots of each step in proof/ (1440 and 390 wide).
 */
import { test, expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import type { Server } from 'node:http'
import { FakeStripe, serveFakeStripe, signFakeEvent, type FakeEvent } from '../tests/billing/fake-stripe'

test.describe.configure({ mode: 'serial' })
test.skip(process.env.E2E_BILLING !== '1', 'set E2E_BILLING=1 and start the server with BILLING_MODE=test and the fake Stripe base URL')

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PORT = Number(process.env.E2E_FAKE_STRIPE_PORT ?? 3517)
const SECRET = process.env.E2E_STRIPE_WEBHOOK_SECRET ?? ''
const OWNER = 'owner@billing-e2e.example'
const ORG = '7e0b1f6a-5b51-4c2a-9a0e-0b11e2e00001'
const CONN = '7e0b1f6a-5b51-4c2a-9a0e-0b11e2e00002'
const UID = '7e0b1f6a-5b51-4c2a-9a0e-0b11e2e00003'

const fake = new FakeStripe([
  { id: 'price_E2EStarter', unit_amount: 2900, currency: 'usd', nickname: 'Starter' },
  { id: 'price_E2EGrowth', unit_amount: 7900, currency: 'usd', nickname: 'Growth' },
  { id: 'price_E2EPro', unit_amount: 19900, currency: 'usd', nickname: 'Pro' },
  { id: 'price_E2EOps', unit_amount: 29900, currency: 'usd', nickname: 'Commerce Operations' },
  { id: 'price_E2EWork', unit_amount: 49900, currency: 'usd', nickname: 'Business Workforce' },
])
let server: Server | null = null

async function db<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

/** Post Stripe's events to the app, signed like Stripe does, in order. */
async function deliver(events: FakeEvent[]) {
  for (const ev of events) {
    const raw = JSON.stringify(ev)
    const res = await fetch(`${BASE}/api/billing/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signFakeEvent(raw, SECRET) }, body: raw })
    expect(res.status, `${ev.type}: ${await res.clone().text()}`).toBe(200)
  }
}

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}
async function pair(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: `proof/${name}-1440.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `proof/${name}-390.png`, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
}
const sub = () => fake.subOf([...fake.customers.keys()][0])!

test.beforeAll(async () => {
  expect(SECRET, 'E2E_STRIPE_WEBHOOK_SECRET must be the server\'s STRIPE_WEBHOOK_SECRET').toMatch(/^whsec_/)
  server = await serveFakeStripe(fake, PORT)
  await db(async c => {
    await c.query(`delete from auth.users where id = $1`, [UID])
    await c.query(`delete from billing_events where org_id = $1`, [ORG])
    await c.query(`delete from agencies where id = $1`, [ORG])
    await c.query(`insert into agencies (id, name, org_type, plan_tier) values ($1, 'Billing E2E Co (synthetic)', 'merchant', 'starter')`, [ORG])
    await c.query(`insert into org_products (org_id, product, enabled_by) values ($1, 'commerce', 'e2e') on conflict do nothing`, [ORG])
    await c.query(`insert into store_connections (id, org_id, platform, external_id, display_name, status, is_synthetic) values ($1,$2,'woocommerce','https://billing-e2e.example','Billing E2E store','active',true)`, [CONN, ORG])
    await c.query(`insert into auth.users (id, email) values ($1,$2)`, [UID, OWNER])
    // the auth shim may already have created the profile row
    await c.query(`insert into profiles (id, email, full_name, role, agency_id) values ($1,$2,'Billing E2E owner','client',$3)
      on conflict (id) do update set agency_id = excluded.agency_id, role = 'client', full_name = excluded.full_name`, [UID, OWNER, ORG])
    await c.query(`update profiles set org_role = 'owner' where id = $1`, [UID])
    // Stripe test prices for the two suite plans (they stay hypotheses: test mode only)
    await c.query(`update plans set stripe_price_id = 'price_E2EOps' where key = 'commerce_operations'`)
    await c.query(`update plans set stripe_price_id = 'price_E2EWork' where key = 'business_workforce'`)
  })
})
test.afterAll(async () => { await new Promise<void>(r => (server ? server.close(() => r()) : r())) })

test('billing page: plans from the plans table labelled pilot pricing; a trial starts through Checkout without a card', async ({ page }) => {
  await page.route('https://checkout.stripe.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Stripe Checkout (fake)</title><h1>Stripe Checkout (fake)</h1>' }))
  await signIn(page, OWNER)
  await page.goto('/store/billing')
  await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible()
  await expect(page.getByText('Pilot pricing', { exact: true }).first()).toBeVisible()
  const ops = page.locator('[data-plan=commerce_operations]')
  await expect(ops).toContainText('$299/month')
  await expect(ops.getByRole('button', { name: 'Start 14-day trial' })).toBeEnabled()
  await pair(page, 'billing-choose')
  await Promise.all([page.waitForURL(/checkout\.stripe\.com/), ops.getByRole('button', { name: 'Start 14-day trial' }).click()])
  const session = [...fake.sessions.values()].at(-1)!
  expect(session.params).toMatchObject({ subscription_data: { trial_period_days: '14' }, payment_method_collection: 'if_required' })
  // the owner finishes Checkout without a card; Stripe sends its events
  await deliver(fake.completeCheckout(session.id, { withCard: false }))
  await page.goto('/store/billing?checkout=success')
  await expect(page.getByTestId('trial-days')).toContainText('14 days left')
  await expect(page.locator('[data-plan=commerce_operations]')).toContainText('Current')
  await pair(page, 'billing-trial')
})

test('trial ends without a payment method: payment failed banner across the app, then recovery when a card is added', async ({ page }) => {
  await deliver(fake.endTrialNow(sub().id))
  await signIn(page, OWNER)
  await page.goto('/store/settings')
  const banner = page.getByTestId('billing-banner')
  await expect(banner).toContainText(/Payment failed\. Update your payment method before \d{4}-\d{2}-\d{2}/)
  await pair(page, 'billing-banner-past-due')
  await page.goto('/store/billing')
  await expect(page.getByRole('heading', { name: 'Payment did not go through' })).toBeVisible()
  await expect(page.getByText('$299 is due.')).toBeVisible()
  await pair(page, 'billing-past-due')
  await deliver(fake.payWithNewCard(sub().customer))
  await page.goto('/store/settings')
  await expect(page.getByRole('heading').first()).toBeVisible()
  await expect(page.getByTestId('billing-banner')).toHaveCount(0)
  await page.goto('/store/billing')
  await expect(page.getByTestId('payment-method')).toHaveText('VISA ending 4242, expires 12/2030')
  await expect(page.getByRole('link', { name: 'View' }).first()).toHaveAttribute('href', /^https:\/\/invoice\.stripe\.com\//)
})

test('upgrade with Stripe\'s preview first; the new plan shows once Stripe confirms', async ({ page }) => {
  await signIn(page, OWNER)
  await page.goto('/store/billing')
  await page.locator('[data-plan=business_workforce]').getByRole('button', { name: 'Upgrade to Business Workforce' }).click()
  const dialog = page.getByRole('dialog', { name: 'Plan change preview' })
  await expect(dialog).toContainText('Upgrade to Business Workforce')
  await expect(dialog).toContainText('prorated difference')
  await expect(dialog.getByTestId('preview-total')).toHaveText(/^\$\d+(\.\d\d)?$/)
  await pair(page, 'billing-preview')
  await dialog.getByRole('button', { name: 'Confirm upgrade' }).click()
  await expect(page.getByText(/Requested: the Business Workforce plan applies as soon as Stripe confirms/)).toBeVisible()
  // still the old plan until Stripe's event arrives
  await expect(page.locator('[data-plan=commerce_operations]')).toContainText('Current')
  await deliver(fake.drain())
  await page.reload()
  await expect(page.locator('[data-plan=business_workforce]')).toContainText('Current')
})

test('cancel at period end with a reason, then reactivate', async ({ page }) => {
  await signIn(page, OWNER)
  await page.goto('/store/billing')
  await page.getByRole('button', { name: 'Cancel subscription' }).click()
  await page.selectOption('#cancel-reason', 'too_expensive')
  await page.getByRole('button', { name: 'Cancel at period end' }).click()
  await expect(page.getByText(/Your subscription will end on \d{4}-\d{2}-\d{2}/)).toBeVisible()
  await deliver(fake.drain())
  await page.reload()
  await expect(page.getByTestId('cancel-scheduled')).toContainText('Your data is kept')
  await pair(page, 'billing-cancel-scheduled')
  await page.getByRole('button', { name: 'Reactivate' }).click()
  await expect(page.getByText('Reactivated: your subscription continues.')).toBeVisible()
  await deliver(fake.drain())
  await page.reload()
  await expect(page.getByTestId('cancel-scheduled')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel subscription' })).toBeVisible()
})

test('a Shopify App Store merchant sees its Shopify billing and is sent to Shopify', async ({ page }) => {
  await signIn(page, 'owner@northwind-goods.example')
  await page.goto('/store/billing')
  await expect(page.getByRole('heading', { name: 'Billed through Shopify' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Choose a plan' })).toHaveCount(0)
  await pair(page, 'billing-shopify')
})
