// Captures proof screenshots against a running preview (default http://localhost:4173).
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
async function shot(name, url, width, { fullPage = true, before } = {}) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' })
  await page.goto(base + url, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  if (before) await before(page)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage })
  await page.close()
  console.log('wrote', `${name}-${width}.png`)
}
for (const w of [1440, 390]) {
  await shot('site-home', '/', w)
  await shot('site-evv', '/evv', w)
  await shot('site-menu-open', '/', w, {
    fullPage: false,
    before: async page => {
      if (w < 960) await page.getByRole('button', { name: 'Open menu' }).click()
    },
  })
}
await browser.close()
