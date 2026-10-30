/**
 * The embedded Shopify app, loaded the way the Shopify admin loads it: an HTML document request for
 * /shopify with ?shop=. App Bridge (cdn.shopify.com) is replaced by a stub that returns ID tokens
 * signed with this environment's app secret, so the real session-token verification, the install
 * endpoint and the bearer-authenticated store API all run. Needs SHOPIFY_API_KEY/SHOPIFY_API_SECRET
 * to be the same values the server was started with.
 */
import { test, expect, type Page } from '@playwright/test'
import { createHmac } from 'node:crypto'

const KEY = process.env.SHOPIFY_API_KEY ?? ''
const SECRET = process.env.SHOPIFY_API_SECRET ?? ''
const SHOP = 'northwind-goods-demo.myshopify.com'
const SCREENS = process.env.E2E_SCREENS_DIR

function idToken(shop: string, secret = SECRET): string {
  const iat = Math.floor(Date.now() / 1000)
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b({ alg: 'HS256', typ: 'JWT' })
  const p = b({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: KEY, sub: '42', exp: iat + 60, nbf: iat - 1, iat, jti: `e2e-${iat}-${Math.random()}`, sid: 'e2e' })
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}

/** Stand-in for Shopify's App Bridge: window.shopify.idToken() and nothing else. */
async function stubAppBridge(page: Page, shop: string, secret = SECRET) {
  await page.route('https://cdn.shopify.com/shopifycloud/app-bridge.js', route => route.fulfill({
    contentType: 'application/javascript',
    // the real App Bridge renders <ui-nav-menu> in the admin sidebar, not inside the app frame
    body: `window.shopify = { idToken: async () => ${JSON.stringify(idToken(shop, secret))} };
      document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'ui-nav-menu{display:none}'; document.head.appendChild(s) });`,
  }))
}

test.skip(!KEY || !SECRET, 'SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be set for the server and the test')

test('the admin loads /shopify: App Bridge is the first script, the frame is limited to the admin, and the store opens', async ({ page }) => {
  await stubAppBridge(page, SHOP)
  const res = await page.goto(`/shopify?shop=${SHOP}&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbm9ydGh3aW5k&embedded=1`)
  expect(res!.headers()['content-security-policy']).toBe(`frame-ancestors https://${SHOP} https://admin.shopify.com;`)
  const html = await res!.text()
  const head = html.slice(0, html.indexOf('</head>'))
  const firstScript = head.match(/<script[^>]*>/)![0]
  expect(firstScript).toBe('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">')
  expect(head.indexOf(`<meta name="shopify-api-key" content="${KEY}"/>`)).toBeGreaterThan(-1)
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  // a synthetic demo store needs no beta access card
  await expect(page.getByText('Deploi is in beta')).toHaveCount(0)
  await page.setViewportSize({ width: 1600, height: 900 })
  const shot = async (name: string) => {
    if (!SCREENS) return
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[aria-busy="true"], .skeleton')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENS}/${name}.png` })
  }
  await expect(page.getByRole('button', { name: /Run scan/ })).toBeVisible()
  await shot('listing-overview')
  await page.goto(`/shopify/agents?shop=${SHOP}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
  await expect(page.getByText('Stock Guardian').first()).toBeVisible()
  await shot('listing-agents')
  await page.goto(`/shopify/issues?shop=${SHOP}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await shot('listing-issues')
  await page.goto(`/shopify/connections?shop=${SHOP}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible()
  await shot('listing-connections')
})

test('a token signed with the wrong secret is refused with the App Bridge retry header, and the page says so', async ({ page }) => {
  await stubAppBridge(page, SHOP, 'not-the-app-secret')
  const refused = page.waitForResponse(r => r.url().endsWith('/api/shopify/session'))
  await page.goto(`/shopify?shop=${SHOP}`)
  const r = await refused
  expect(r.status()).toBe(401)
  expect(r.headers()['x-shopify-retry-invalid-session-request']).toBe('1')
  await expect(page.getByText('Could not connect to your store.')).toBeVisible()
})

test('outside the Shopify admin (no App Bridge) the embedded page explains how to open it', async ({ page }) => {
  await page.route('https://cdn.shopify.com/shopifycloud/app-bridge.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await page.goto('/shopify')
  await expect(page.getByRole('heading', { name: 'Open this app from your Shopify admin' })).toBeVisible()
})
