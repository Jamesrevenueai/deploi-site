/**
 * Free at launch (founder decision 2026-11-23): while BILLING_REQUIRED is off, no Shopify store is charged.
 *   - POST /api/billing/subscribe refuses every Store plan with 409 free_at_launch before anything reaches Shopify
 *   - GET /api/billing/cap tells the plan page that Store billing is off (it shows "Free during launch")
 *   - plan gating still holds: a Starter store cannot switch on a Growth or Pro agent (402), so turning billing on later
 *     changes what is charged, not what is allowed
 * With BILLING_REQUIRED=true the Store path is open again (it then needs a connected store).
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'
import { resetLibrary } from '../library/helpers'
import { NW } from '../merchant/helpers'
import { admin } from '../../lib/db'

let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookieValue ? { value: cookieValue } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))

const ready = await prepareDb()
const req = (path: string, method = 'GET', body?: unknown) => new Request(`http://localhost:3000${path}`, { method, headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const saved = process.env.BILLING_REQUIRED

describe.skipIf(!ready)('free at launch (BILLING_REQUIRED off)', () => {
  beforeEach(async () => { cookieValue = encodeDevSession(SESSIONS.northwind); delete process.env.BILLING_REQUIRED; await resetLibrary(NW, 'starter') })
  afterEach(() => { if (saved === undefined) delete process.env.BILLING_REQUIRED; else process.env.BILLING_REQUIRED = saved })

  for (const plan of ['starter', 'growth', 'pro']) {
    it(`${plan}: no Shopify subscription can be started (409 free_at_launch)`, async () => {
      const { POST } = await import('../../app/api/billing/subscribe/route')
      const res = await POST(req('/api/billing/subscribe', 'POST', { plan, interval: 'month', capCents: 5000 }))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, error: 'free_at_launch' })
    })
  }
  it('the plan page is told Store billing is off', async () => {
    const { GET } = await import('../../app/api/billing/cap/route')
    const r = await (await GET(req('/api/billing/cap'))).json() as { ok: boolean; storeBillingRequired: boolean }
    expect(r).toMatchObject({ ok: true, storeBillingRequired: false })
  })
  it('plan gating still holds while free: a Starter store cannot switch on Returns (Growth) or AI Visibility (Pro); Order Tracker (Starter) switches on', async () => {
    const { POST } = await import('../../app/api/store/library/[key]/[action]/route')
    const sw = async (key: string) => (await POST(req(`/api/store/library/${key}/switch`, 'POST', { enabled: true }), { params: Promise.resolve({ key, action: 'switch' }) })).status
    expect(await sw('returns')).toBe(402)
    expect(await sw('ai_visibility')).toBe(402)
    expect(await sw('order_tracker')).toBe(200)
  })
  it('with BILLING_REQUIRED=true the Store path is open again (and asks for a connected Shopify store first)', async () => {
    process.env.BILLING_REQUIRED = 'true'
    const { POST } = await import('../../app/api/billing/subscribe/route')
    try {
      const res = await POST(req('/api/billing/subscribe', 'POST', { plan: 'starter', interval: 'month', capCents: 5000 }))
      expect((await res.json() as { error?: string }).error).not.toBe('free_at_launch')
    } finally {
      // the synthetic store may have created a TEST subscription; leave Northwind as other suites expect it
      await admin(async db => {
        await db.query(`delete from app_subscriptions where connection_id = $1 and provider = 'shopify_billing'`, [NW.conn])
        await db.query('delete from org_usage_caps where org_id = $1', [NW.org])
      })
    }
  })
})
