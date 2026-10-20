// Renders /public/og.png (1200x630) with Playwright. Run: npm run og
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const SCRATCH = '/tmp/claude-0/-home-user-Jamesrevenueai/460b7362-9bad-5ba0-9961-686c1522e4dd/scratchpad/node_modules'
const req = createRequire(path.join(SCRATCH, 'x.js'))
let chromium
try { ({ chromium } = req('playwright')) } catch { ({ chromium } = await import('playwright')) }
const here = path.dirname(fileURLToPath(import.meta.url))
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=block">
<style>
  html,body{margin:0;width:1200px;height:630px;background:#000;font-family:Inter,sans-serif;color:#fff}
  .wrap{position:relative;width:1200px;height:630px;display:flex;flex-direction:column;justify-content:space-between;padding:72px 80px;box-sizing:border-box}
  .brand{font-weight:700;font-size:40px;letter-spacing:-0.02em}
  h1{margin:0;font-weight:600;font-size:76px;line-height:1.05;letter-spacing:-0.02em}
  h1 .g{color:#8A8A8A}
  .sub{color:#A3A3A3;font-size:26px;font-weight:400}
  .dots{position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 1.5px);background-size:72px 72px}
</style></head><body><div class="wrap"><div class="dots"></div>
<div class="brand">deploi</div>
<h1><span class="g">More clients.</span><br><span class="g">More aides.</span><br>Fewer missed visits.</h1>
<div class="sub">Operations &amp; technology for Medicaid home care and DODD agencies</div>
</div></body></html>`
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: path.join(here, '..', 'public', 'og.png'), type: 'png' })
await browser.close()
console.log('wrote public/og.png')
