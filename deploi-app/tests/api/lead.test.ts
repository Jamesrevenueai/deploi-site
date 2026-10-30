// tests/setup.ts forces .env.test; the web stream runs against its own database when asked.
if (process.env.WEB_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.WEB_TEST_DATABASE_URL
import { describe, it, expect, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const post = async (body: unknown, origin = 'https://getdeploi.com') => {
  const { POST } = await import('../../app/api/public/lead/route')
  const r = await POST(new Request('http://localhost/api/public/lead', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }))
  return { status: r.status, json: await r.json() as { ok: boolean; id: string | null }, headers: r.headers }
}
const EMAILS = ['early-access@example.com', 'early-old-field@example.com', 'early-secret@example.com', 'old-consulting@example.com']
const cleanup = (email: string) => admin(db => db.query('delete from prospects where lower(email) = lower($1)', [email]))
const body = { name: 'Early Tester', email: 'early-access@example.com', store_name: 'Early Test Store', source: 'site', service_interest: 'early_access',
  store_url: 'https://early-test-store.example', platforms: ['shopify', 'amazon'], catalog_size: '100_1000', message: 'Variants keep selling at zero', website: '' }

describe.skipIf(!ready)('POST /api/public/lead (early access applications only)', () => {
  afterAll(async () => { for (const e of EMAILS) await cleanup(e) })

  it('an application (the exact website contract) creates a tagged prospect and a touch; resubmitting dedupes', async () => {
    const r = await post(body)
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe('https://getdeploi.com')
    const p = await admin(db => db.one<{ agency_name: string; service_interest: string; tags: string[]; website_url: string; website_details: Record<string, unknown> }>(
      'select agency_name, service_interest, tags, website_url, website_details from prospects where id = $1', [r.json.id]))
    expect(p).toMatchObject({ agency_name: 'Early Test Store', service_interest: 'early_access', website_url: 'https://early-test-store.example', website_details: { platforms: ['amazon', 'shopify'], catalog_size: '100_1000' } })
    expect(p!.tags).toEqual(expect.arrayContaining(['Early Access', 'Shopify', 'Amazon']))
    const again = await post(body)
    expect(again.json.id).toBe(r.json.id)
    const touches = await admin(db => db.query<{ body: string }>('select body from touches where prospect_id = $1', [r.json.id]))
    expect(touches.map(t => t.body)).toEqual(['Variants keep selling at zero', 'Variants keep selling at zero'])
  })

  it('refuses a bad store address, no platform, an unknown platform, and the old consulting lead with no store', async () => {
    expect((await post({ ...body, store_url: 'early-test-store.example' })).status).toBe(400)
    expect((await post({ ...body, platforms: [] })).status).toBe(400)
    expect((await post({ ...body, platforms: ['ebay'] })).status).toBe(400)
    const old = await post({ name: 'Old Lead', email: 'old-consulting@example.com', agency_name: 'Some Home Care', message: 'help', source: 'site' })
    expect(old.status).toBe(400)
    expect((await post({ ...body, email: 'old-consulting@example.com', service_interest: 'operations' })).status).toBe(400)
    expect((await post({ ...body, email: 'old-consulting@example.com', source: 'evv-page' })).status).toBe(400)
    const n = await admin(db => db.one<{ n: string }>('select count(*)::text as n from prospects where lower(email) = $1', ['old-consulting@example.com']))
    expect(n!.n).toBe('0')
  })

  it('still accepts the store name under its old field name from an older website build', async () => {
    const r = await post({ ...body, store_name: undefined, email: 'early-old-field@example.com', agency_name: 'Old Field Store' })
    expect(r.status).toBe(200)
    const p = await admin(db => db.one<{ agency_name: string }>('select agency_name from prospects where id = $1', [r.json.id]))
    expect(p!.agency_name).toBe('Old Field Store')
  })

  it('removes password-like text, ignores bots, and refuses other origins in CORS', async () => {
    const r = await post({ ...body, email: 'early-secret@example.com', message: 'my admin password: hunter2 please' })
    const t = await admin(db => db.one<{ body: string }>('select body from touches where prospect_id = $1 order by at desc limit 1', [r.json.id]))
    expect(t!.body).toBe('my admin password: [removed] please')
    const bot = await post({ ...body, email: 'early-secret@example.com', website: 'http://spam' })
    expect(bot.json).toEqual({ ok: true, id: null })
    const { OPTIONS } = await import('../../app/api/public/lead/route')
    const pre = await OPTIONS(new Request('http://localhost/api/public/lead', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
  })
})
