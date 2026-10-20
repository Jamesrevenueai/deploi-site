/**
 * Section 9 end-to-end: staff imports prospects, logs a call, creates an assessment,
 * completes both traces, calculates leaks, generates and opens the PDF; a client sees
 * the morning report dashboard; staff sees the morning report email preview.
 * Runs against a server in dev-auth mode (AUTH_MODE=dev) with the seed applied.
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { STEPS } from '../lib/assessments/steps'

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

let prospectId = ''
let assessmentId = ''

test('staff imports 20 prospects from the CSV fixture', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto('/staff/pipeline/import')
  await page.setInputFiles('input[name=file]', path.resolve(__dirname, '../tests/fixtures/prospects-20.csv'))
  await page.locator('form:has(input[name=file]) button[type=submit]').click()
  const importBtn = page.getByRole('button', { name: /Import 20 rows/ })
  await expect(importBtn).toBeVisible()
  await importBtn.click()
  const result = page.locator('.tile-value', { hasText: /imported \/ \d+ skipped/ })
  await expect(result).toBeVisible({ timeout: 30_000 })
  const text = (await result.textContent()) ?? ''
  console.log(`e2e import: ${text.trim()}`)
  expect(text).toMatch(/^\d+ imported \/ \d+ skipped$/)
})

test('staff logs a call on an imported prospect', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto('/staff/pipeline?view=list&q=Hilltop')
  const link = page.locator('a[href^="/staff/pipeline/"]').filter({ hasText: 'Hilltop Caring Hands' }).first()
  const href = await link.getAttribute('href')
  expect(href).toMatch(/\/staff\/pipeline\/[0-9a-f-]{36}$/)
  prospectId = href!.split('/').pop()!
  await page.goto(href!)
  await page.selectOption('#outcome', 'held')
  await page.fill('#biggest_leak', 'Referrals sit in a shared inbox until the next morning')
  await page.fill('#next_step', 'Send the assessment proposal')
  await page.fill('#follow_up_at', new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10))
  await page.locator('form:has(#outcome) button[type=submit]').click()
  await expect(page.getByText('Referrals sit in a shared inbox until the next morning').first()).toBeVisible()
  await expect(page.getByText(/call held/i).first()).toBeVisible()
})

test('staff creates an assessment and completes both traces', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto(`/staff/assessments/new?prospect=${prospectId}`)
  await page.fill('#fee_dollars', '1500')
  await Promise.all([page.waitForURL(/\/staff\/assessments\/[0-9a-f-]{36}/), page.locator('form:has(#fee_dollars) button[type=submit]').click()])
  assessmentId = page.url().match(/\/staff\/assessments\/([0-9a-f-]{36})/)![1]
  let t = Date.now() - 10 * 86400e3
  for (const trace of ['referral', 'visit'] as const) {
    for (const step of STEPS[trace]) {
      const base = `${trace}-${step.key}`
      t += 3 * 3600e3
      const d = new Date(t)
      const p = (n: number) => String(n).padStart(2, '0')
      const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
      await page.fill(`#${base}-at`, local)
      await page.fill(`#${base}-who`, 'Scheduler')
      if (step.outcome) await page.selectOption(`#${base}-outcome`, step.outcome.options[step.key === 'paid_or_denied' ? 1 : 0])
      await page.locator(`li#${base} button[type=submit]`).click()
      await expect(page.locator(`li#${base}`).getByText('saved')).toBeVisible({ timeout: 20_000 })
    }
  }
  await expect(page.locator('#referral').getByText('6 / 6 steps')).toBeVisible()
  await expect(page.locator('#visit').getByText('8 / 8 steps')).toBeVisible()
})

test('staff calculates leaks, generates the PDF and opens it', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto(`/staff/assessments/${assessmentId}`)
  await page.fill('#avg_monthly_referrals', '9')
  await page.fill('#avg_referral_value_year', '18000')
  await page.fill('#aide_turnover_12mo', '7')
  await page.fill('#open_shift_hours_week', '22')
  await page.fill('#evv_denial_rate', '0.06')
  await Promise.all([page.waitForURL(/\/report/, { timeout: 30_000 }), page.getByRole('button', { name: /Calculate the three leaks/ }).click()])
  await expect(page.getByText('Leak 1')).toBeVisible()
  await expect(page.getByText(/\$[\d,]+/).first()).toBeVisible()
  await Promise.all([page.waitForURL(/generated=1/, { timeout: 60_000 }), page.getByRole('button', { name: /Generate PDF/ }).click()])
  const res = await page.request.get(`/api/reports/${assessmentId}`)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/pdf')
  const body = await res.body()
  expect(body.subarray(0, 4).toString()).toBe('%PDF')
  console.log(`e2e pdf: ${body.length} bytes`)
})

test('client sees the morning report dashboard with seed numbers', async ({ page }) => {
  await signIn(page, 'admin@buckeyehomecare.example')
  await page.goto('/app/home')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buckeye Home Care/)
  for (const label of [/Referrals/i, /Shifts/i, /EVV/i, /Authorization/i, /Applicants/i, /Credential/i]) {
    await expect(page.locator('.tile-label', { hasText: label }).first()).toBeVisible()
  }
  const values = await page.locator('.tile-value').allTextContents()
  console.log(`e2e dashboard tiles: ${values.map(v => v.trim()).join(' | ')}`)
  expect(values.length).toBeGreaterThanOrEqual(6)
  await expect(page.locator('.tile-value', { hasText: /^6/ }).first()).toBeVisible() // 6 open shifts in the seed
  const report = page.locator('a[href^="/api/reports/"]').first()
  if (await report.count()) {
    const res = await page.request.get((await report.getAttribute('href'))!)
    expect(res.headers()['content-type']).toContain('application/pdf')
  }
  // a client must never reach the staff area
  await page.goto('/staff/pipeline')
  await expect(page).toHaveURL(/\/app\/home/)
})

test('staff sees the morning report preview', async ({ page }) => {
  await signIn(page, 'hello@getdeploi.com')
  await page.goto('/staff/emails/preview')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const frame = page.frameLocator('iframe').first()
  await expect(frame.locator('body')).toContainText(/Buckeye Home Care/, { timeout: 20_000 })
  await expect(page.locator('body')).toContainText(/Referrals answered|Shifts filled/i)
})
