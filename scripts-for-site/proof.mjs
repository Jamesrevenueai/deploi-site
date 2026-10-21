// Captures proof screenshots against a running preview (default http://localhost:4173).
// Usage: BASE_URL=http://localhost:5174 PLAYWRIGHT_NODE_MODULES=deploi-app/node_modules node scripts-for-site/proof.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// Playwright is resolved from PLAYWRIGHT_NODE_MODULES (a directory holding node_modules/playwright) or this package.
const req = createRequire(path.join(process.env.PLAYWRIGHT_NODE_MODULES ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'), 'x.js'))
let chromium
try { ({ chromium } = req('playwright')) } catch { ({ chromium } = await import('playwright')) }
const base = process.env.BASE_URL ?? 'http://localhost:4173'
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'proof')
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const problems = []
async function shot(name, url, width, { fullPage = true, before } = {}) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' })
  // The lead API is stubbed so the form proofs never post anywhere.
  await page.route('**/api/public/lead', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 'proof' }) }))
  page.on('pageerror', e => problems.push(`${name}-${width}: pageerror ${e.message}`))
  await page.goto(base + url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  if (before) await before(page)
  await page.waitForTimeout(300)
  // No horizontal overflow at any width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 1) problems.push(`${name}-${width}: horizontal overflow ${overflow}px`)
  await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage })
  await page.close()
  console.log('wrote', `${name}-${width}.png`)
}
for (const w of [1440, 390]) {
  await shot('site-home', '/', w)
  await shot('site-website', '/website', w)
  await shot('site-baa', '/baa', w)
  await shot('site-evv', '/evv', w)
  await shot('site-404', '/this-page-does-not-exist', w, { fullPage: false })
  await shot('site-menu-open', '/', w, {
    fullPage: false,
    before: async page => {
      if (w < 960) await page.getByRole('button', { name: 'Open menu' }).click()
    },
  })
  // Website form: validation error, then (against the stubbed API) the success state.
  await shot('site-website-form-error', '/website', w, {
    fullPage: false,
    before: async page => {
      await page.getByLabel('Name', { exact: true }).fill('Pat Example')
      await page.getByLabel('Work email', { exact: true }).fill('pat@example-agency.test')
      await page.getByLabel('Practice or agency name').fill('Example Home Care')
      await page.getByLabel('Website URL').fill('example-agency.test')
      await page.getByRole('button', { name: 'Request website improvements' }).click()
      await page.getByRole('alert').waitFor()
      await page.getByRole('alert').scrollIntoViewIfNeeded()
    },
  })
  await shot('site-website-form-success', '/website', w, {
    fullPage: false,
    before: async page => {
      await page.getByLabel('Name', { exact: true }).fill('Pat Example')
      await page.getByLabel('Work email', { exact: true }).fill('pat@example-agency.test')
      await page.getByLabel('Practice or agency name').fill('Example Home Care')
      await page.getByLabel('Website URL').fill('https://example-agency.test')
      await page.getByLabel('Website platform').selectOption('WordPress')
      await page.getByLabel('Main business goal').fill('More private-pay inquiries')
      await page.getByLabel('Page 1 to improve').fill('Home')
      await page.getByLabel('Requested changes').fill('Clearer services page')
      await page.getByLabel('Access status').selectOption('have_login')
      await page.getByRole('button', { name: 'Request website improvements' }).click()
      await page.locator('.confirmation').waitFor()
      await page.locator('.confirmation').scrollIntoViewIfNeeded()
    },
  })
  // Home form: validation error state.
  await shot('site-home-form-error', '/', w, {
    fullPage: false,
    before: async page => {
      const form = page.locator('#book form')
      await form.getByLabel('Name', { exact: true }).fill('Pat Example')
      await form.getByLabel('Work email').fill('not-an-email')
      await form.getByLabel('Agency or practice').fill('Example Home Care')
      await form.getByRole('button', { name: 'Request a discovery conversation' }).click()
      await form.getByRole('alert').waitFor()
      await form.getByRole('alert').scrollIntoViewIfNeeded()
    },
  })
}
await browser.close()
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'))
  process.exit(1)
}
console.log('no page errors, no horizontal overflow')
