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
async function fillEarlyAccess(page, storeUrl) {
  const form = page.locator('#early-access form')
  await form.getByLabel('Name', { exact: true }).fill('Pat Example')
  await form.getByLabel('Work email').fill('pat@example-store.test')
  await form.getByLabel('Store or company name').fill('Example Store')
  await form.getByLabel('Store URL').fill(storeUrl)
  return form
}
for (const w of [1440, 390]) {
  await shot('site-home', '/', w)
  await shot('site-privacy', '/privacy', w)
  await shot('site-404', '/this-page-does-not-exist', w, { fullPage: false })
  await shot('site-menu-open', '/', w, {
    fullPage: false,
    before: async page => {
      if (w < 960) await page.getByRole('button', { name: 'Open menu' }).click()
    },
  })
  // Early access form: validation error (URL without http/https), then the success state against the stubbed API.
  await shot('site-home-form-error', '/', w, {
    fullPage: false,
    before: async page => {
      const form = await fillEarlyAccess(page, 'example-store.test')
      await form.getByRole('button', { name: 'Apply for Early Access' }).click()
      await form.getByRole('alert').waitFor()
      await form.getByRole('alert').evaluate(el => el.scrollIntoView({ block: 'center' }))
    },
  })
  await shot('site-home-form-success', '/', w, {
    fullPage: false,
    before: async page => {
      const form = await fillEarlyAccess(page, 'https://example-store.test')
      await form.getByLabel(/Approximate number of products/).selectOption('100_1000')
      await form.getByRole('button', { name: 'Apply for Early Access' }).click()
      await page.locator('#early-access .confirmation').waitFor()
      await page.locator('#early-access .confirmation').evaluate(el => el.scrollIntoView({ block: 'center' }))
    },
  })
}
await browser.close()
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'))
  process.exit(1)
}
console.log('no page errors, no horizontal overflow')
