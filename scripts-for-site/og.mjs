// Renders /public/og.png (1200x630) with Playwright in the Indigo look of the homepage (design-ref/site-home.html).
// Fonts are the self-hosted @fontsource files (no Google Fonts). Run: npm run og
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Playwright is resolved from PLAYWRIGHT_NODE_MODULES (a directory holding node_modules/playwright) or this package.
const req = createRequire(path.join(process.env.PLAYWRIGHT_NODE_MODULES ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'), 'x.js'))
let chromium
try { ({ chromium } = req('playwright')) } catch { ({ chromium } = await import('playwright')) }
const here = path.dirname(fileURLToPath(import.meta.url))
const fontsDir = path.join(here, '..', 'node_modules', '@fontsource')
const face = (family, file, weight) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fontsDir, file)).toString('base64')}) format('woff2')}`
const fonts = [
  ...[600, 800].map(w => face('Plus Jakarta Sans', `plus-jakarta-sans/files/plus-jakarta-sans-latin-${w}-normal.woff2`, w)),
  face('JetBrains Mono', 'jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 500),
].join('\n')
const mark = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#EEF2FF"/><path d="M10 10 L22 11 L21 22 L11 21 Z M10 10 L21 22" stroke="#A5B4FC" stroke-width="1.5" fill="none"/><circle cx="10" cy="10" r="3.6" fill="#4F46E5"/><circle cx="22" cy="11" r="2.6" fill="#4F46E5"/><circle cx="11" cy="21" r="2.6" fill="#4F46E5"/><circle cx="21" cy="22" r="2.8" fill="#E8734A"/></svg>`
const bot = `<svg width="150" height="150" viewBox="0 0 96 96"><path d="M48 26V16" stroke="#4F46E5" stroke-width="3" stroke-linecap="round"/><circle cx="48" cy="14" r="5" fill="#E8734A"/><rect x="18" y="26" width="60" height="44" rx="17" fill="#4F46E5"/><rect x="27" y="36" width="42" height="22" rx="11" fill="#EEF2FF"/><circle cx="39" cy="47" r="4.5" fill="#1E1B4B"/><circle cx="57" cy="47" r="4.5" fill="#1E1B4B"/><rect x="34" y="74" width="28" height="10" rx="5" fill="#C7D2FE"/></svg>`
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${fonts}
  html,body{margin:0;width:1200px;height:630px;background:#FFFFFF;font-family:'Plus Jakarta Sans',sans-serif;color:#1E1B4B}
  .wrap{position:relative;width:1200px;height:630px;box-sizing:border-box;padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;
    background-image:radial-gradient(#C7D2FE 1.6px, transparent 1.6px);background-size:28px 28px}
  .brand{display:flex;align-items:center;gap:16px;font-size:40px;font-weight:800;letter-spacing:-0.02em}
  .brand span{color:#4F46E5}
  h1{margin:0;font-size:92px;line-height:0.98;font-weight:800;letter-spacing:-0.045em;max-width:900px;background:rgba(255,255,255,0.86);border-radius:24px}
  h1 span{color:#4F46E5}
  .sub{display:flex;gap:14px;font-family:'JetBrains Mono',monospace;font-size:22px;color:#4F46E5;letter-spacing:0.06em;text-transform:uppercase}
  .bot{position:absolute;right:84px;top:200px;width:210px;height:210px;border-radius:56px;background:#FFFFFF;border:2px solid #E0E7FF;box-shadow:0 30px 70px rgba(49,46,129,0.16);display:flex;align-items:center;justify-content:center}
</style></head><body><div class="wrap">
<div class="brand">${mark(64)}<div>deploi<span>.ai</span></div></div>
<h1>Your store,<br>run by a team<br>of <span>AI agents.</span></h1>
<div class="sub">Store agents · Deploi Office</div>
<div class="bot">${bot}</div>
</div></body></html>`
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: path.join(here, '..', 'public', 'og.png'), type: 'png' })
await browser.close()
console.log('wrote public/og.png')
