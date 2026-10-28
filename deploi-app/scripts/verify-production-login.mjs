#!/usr/bin/env node
/**
 * Checks that a deployment no longer offers the development sign-in. Run it after AUTH_MODE and
 * ALLOW_DEV_LOGIN are removed from Production and the app is redeployed:
 *
 *   node scripts/verify-production-login.mjs https://app.getdeploi.com
 *
 * Read-only: it sends GET requests only, signs no one in, and needs no secrets. Exit code 0 means
 * every check passed; 1 means at least one failed (each failure is printed).
 *
 * Optional, stronger dev-login check: if you still have the APP_SECRET that production used while the
 * picker was public, and a staff profile id, set DEV_TEST_SECRET and DEV_TEST_UID. The script then
 * signs a real development session cookie for that staff profile and checks the app ignores it.
 */
import { createHmac } from 'node:crypto'

const base = (process.argv[2] ?? '').replace(/\/$/, '')
if (!/^https?:\/\//.test(base)) { console.error('usage: node scripts/verify-production-login.mjs <base-url>'); process.exit(2) }

const STAFF_EMAILS = ['hello@getdeploi.com', 'ojae@getdeploi.com']
const DEV_COOKIE = 'deploi_dev_session'
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }
const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers: { 'user-agent': 'deploi-verify-production-login', ...headers } })

// 1. the login page offers only the emailed one-time link
const login = await get('/login')
const html = login.status === 200 ? await login.text() : ''
check('/login answers 200', login.status === 200, `status ${login.status}`)
check('/login says "We will email you a one-time sign-in link"', html.includes('We will email you a one-time sign-in link'))
check('/login has no development sign-in text', !/Development sign-in|pick a seeded user|Dev auth is on/i.test(html))
check('/login has no user picker', !/<select[^>]*name="email"/i.test(html))
// an account offered for sign-in (a picker option or a "· staff" label), not the "Questions? hello@…" contact line
const offered = [...html.matchAll(/<option[^>]*value="([^"]*@[^"]*)"/gi)].map(m => m[1].toLowerCase())
const listed = STAFF_EMAILS.filter(e => offered.includes(e))
check('/login lists no staff accounts', offered.length === 0 && !/·\s*staff/i.test(html), [...listed, ...offered.filter(o => !listed.includes(o))].join(', '))

// 2. the server reports Supabase sign-in, so the dev sign-in action refuses (it redirects to dev-auth-disabled)
const health = await get('/api/health')
let auth = null
try { auth = (await health.json()).auth } catch { /* not JSON */ }
check('/api/health reports auth "supabase"', auth === 'supabase', `auth=${auth}`)

// 3. a development session cookie is ignored: protected pages still send you to /login
const toLogin = r => r.status >= 300 && r.status < 400 && /\/login/.test(r.headers.get('location') ?? '')
const forged = `${Buffer.from(JSON.stringify({ uid: '00000000-0000-0000-0000-000000000000', email: STAFF_EMAILS[0], role: 'staff', agencyId: null })).toString('base64url')}.forged`
for (const path of ['/staff', '/store']) {
  const r = await get(path, { cookie: `${DEV_COOKIE}=${forged}` })
  // 404: the deployed commit has no such page (the merchant area came later), which is also no access
  check(`${path} with a forged dev cookie redirects to /login`, toLogin(r) || r.status === 404, r.status === 404 ? 'page not in this deployment' : `status ${r.status} → ${r.headers.get('location') ?? '-'}`)
}
if (process.env.DEV_TEST_SECRET && process.env.DEV_TEST_UID) {
  const p = Buffer.from(JSON.stringify({ uid: process.env.DEV_TEST_UID, email: STAFF_EMAILS[0], role: 'staff', agencyId: null })).toString('base64url')
  const signed = `${p}.${createHmac('sha256', process.env.DEV_TEST_SECRET).update(p).digest('base64url')}`
  const r = await get('/staff', { cookie: `${DEV_COOKIE}=${signed}` })
  check('/staff with a correctly signed dev cookie redirects to /login', toLogin(r), `status ${r.status} → ${r.headers.get('location') ?? '-'}`)
} else console.log('SKIP  signed dev cookie check (set DEV_TEST_SECRET and DEV_TEST_UID to run it)')

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
