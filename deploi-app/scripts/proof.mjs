/**
 * Screenshot helper. Signs in through the dev login and captures pages at 1440 and 390.
 *   node scripts/proof.mjs <base> <as:email|-> <name=path> [...]
 * Example: node scripts/proof.mjs http://localhost:3000 hello@getdeploi.com staff-audit=/staff/audit
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [base, email, ...pairs] = process.argv.slice(2)
mkdirSync('proof', { recursive: true })
const browser = await chromium.launch()
for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  if (email && email !== '-') {
    await page.goto(`${base}/login`)
    await page.selectOption('select[name=email]', email)
    await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
  }
  for (const pair of pairs) {
    const [name, path] = pair.split('=')
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `proof/${name}-${tag}.png`, fullPage: true })
    console.log(`proof/${name}-${tag}.png`)
  }
  await ctx.close()
}
await browser.close()
