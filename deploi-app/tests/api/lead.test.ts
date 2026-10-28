// tests/setup.ts forces .env.test; the web stream runs against its own database when asked.
if (process.env.WEB_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.WEB_TEST_DATABASE_URL
import { describe, it, expect, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const post = async (body: unknown) => {
  const { POST } = await import('../../app/api/public/lead/route')
  const r = await POST(new Request('http://localhost/api/public/lead', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://getdeploi.com' }, body: JSON.stringify(body) }))
  return { status: r.status, json: await r.json() as { ok: boolean; id: string | null }, headers: r.headers }
}
const cleanup = (email: string) => admin(db => db.query('delete from prospects where lower(email) = lower($1)', [email]))

describe.skipIf(!ready)('POST /api/public/lead', () => {
  afterAll(async () => { for (const e of ['lead-test@example.com', 'web-lead@example.com', 'web-secret@example.com', 'web-unknown@example.com', 'early-access@example.com']) await cleanup(e) })

  it('an early access application (the exact website contract) creates a tagged prospect; bad url or no platform is refused', async () => {
    const body = { name: 'Early Tester', email: 'early-access@example.com', agency_name: 'Early Test Store', source: 'site', service_interest: 'early_access',
      store_url: 'https://early-test-store.example', platforms: ['shopify', 'amazon'], catalog_size: '100_1000', message: 'Variants keep selling at zero', website: '' }
    const r = await post(body)
    expect(r.status).toBe(200)
    const p = await admin(db => db.one<{ service_interest: string; tags: string[]; website_url: string; website_details: Record<string, unknown> }>(
      'select service_interest, tags, website_url, website_details from prospects where id = $1', [r.json.id]))
    expect(p).toMatchObject({ service_interest: 'early_access', website_url: 'https://early-test-store.example', website_details: { platforms: ['amazon', 'shopify'], catalog_size: '100_1000' } })
    expect(p!.tags).toEqual(expect.arrayContaining(['Early Access', 'Shopify', 'Amazon']))
    expect((await post({ ...body, store_url: 'early-test-store.example' })).status).toBe(400)
    expect((await post({ ...body, platforms: [] })).status).toBe(400)
    expect((await post({ ...body, platforms: ['ebay'] })).status).toBe(400)
  })

  it('creates a prospect with source=site and a touch, dedupes on email + agency (unchanged for a normal lead)', async () => {
    const { OPTIONS } = await import('../../app/api/public/lead/route')
    const body = { name: 'Lead Tester', email: 'lead-test@example.com', agency_name: 'Lead Test Agency', message: 'help', source: 'site' }
    const r1 = await post(body)
    expect(r1.status).toBe(200)
    expect(r1.json.ok).toBe(true)
    expect(r1.headers.get('access-control-allow-origin')).toBe('https://getdeploi.com')
    const r2 = await post(body)
    expect(r2.json.id).toBe(r1.json.id)
    const touches = await admin(db => db.query('select id from touches where prospect_id = $1', [r1.json.id]))
    expect(touches.length).toBe(2)
    const lead = await admin(db => db.one<{ source: string; service_interest: string; tags: string[]; website_url: string | null }>('select source, service_interest, tags, website_url from leads where id = $1', [r1.json.id]))
    expect(lead?.source).toBe('site')
    expect(lead?.service_interest).toBe('operations')
    expect(lead?.tags).toEqual([])
    expect(lead?.website_url).toBeNull()
    const eng = await admin(db => db.query('select id from website_engagements where prospect_id = $1', [r1.json.id]))
    expect(eng.length).toBe(0)
    const pre = await OPTIONS(new Request('http://localhost/api/public/lead', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
  })

  it('a website lead creates a tagged prospect with url/goal and a website_engagements row in inquiry; no assessment', async () => {
    const r = await post({
      name: 'Web Lead', email: 'web-lead@example.com', agency_name: 'Riverside Dental (test)', source: 'site', message: 'Our site is hard to use on phones.',
      service_interest: 'website_improvement', website_url: 'https://riverside-dental.example', website_platform: 'WordPress', website_goal: 'more new-patient calls',
      website_pages: ['Home', 'Services', 'Contact'], website_changes: 'clearer CTA', website_issues: 'tables collapse on mobile', access_status: 'have_login', approval_contact: 'Office manager',
    })
    expect(r.status).toBe(200)
    const p = await admin(db => db.one<{ service_interest: string; tags: string[]; website_url: string; website_goal: string; website_details: Record<string, unknown> }>(
      'select service_interest, tags, website_url, website_goal, website_details from prospects where id = $1', [r.json.id]))
    expect(p?.service_interest).toBe('website_improvement')
    expect(p?.tags).toContain('Website Improvement')
    expect(p?.website_url).toBe('https://riverside-dental.example')
    expect(p?.website_goal).toBe('more new-patient calls')
    expect(p?.website_details.platform).toBe('WordPress')
    const eng = await admin(db => db.query<{ status: string; pages: string[]; access_status: string; price_cents: number; approval_contact: string; payment_status: string; payment_is_mock: boolean }>(
      'select status, pages, access_status, price_cents, approval_contact, payment_status, payment_is_mock from website_engagements where prospect_id = $1', [r.json.id]))
    expect(eng.length).toBe(1)
    expect(eng[0]).toMatchObject({ status: 'inquiry', pages: ['Home', 'Services', 'Contact'], access_status: 'have_login', price_cents: 50000, approval_contact: 'Office manager', payment_status: 'unpaid', payment_is_mock: true })
    const assessments = await admin(db => db.query('select id from assessments where prospect_id = $1', [r.json.id]))
    expect(assessments.length).toBe(0)
    // a second submission from the same lead does not create a second inquiry
    await post({ name: 'Web Lead', email: 'web-lead@example.com', agency_name: 'Riverside Dental (test)', source: 'site', service_interest: 'website_improvement' })
    const again = await admin(db => db.query('select id from website_engagements where prospect_id = $1', [r.json.id]))
    expect(again.length).toBe(1)
  })

  it('ignores unknown fields, rejects more than 3 pages and bad enums', async () => {
    const ok = await post({ name: 'U', email: 'web-unknown@example.com', agency_name: 'Unknown Fields Co', source: 'site', service_interest: 'website_improvement', website_pages: ['A'], surprise: 'ignored', nested: { x: 1 } })
    expect(ok.status).toBe(200)
    const four = await post({ name: 'U', email: 'web-unknown@example.com', agency_name: 'Unknown Fields Co', source: 'site', service_interest: 'website_improvement', website_pages: ['A', 'B', 'C', 'D'] })
    expect(four.status).toBe(400)
    const badEnum = await post({ name: 'U', email: 'web-unknown@example.com', agency_name: 'Unknown Fields Co', source: 'site', service_interest: 'redesign' })
    expect(badEnum.status).toBe(400)
    const badAccess = await post({ name: 'U', email: 'web-unknown@example.com', agency_name: 'Unknown Fields Co', source: 'site', access_status: 'shared_password' })
    expect(badAccess.status).toBe(400)
  })

  it('never stores a password-like segment from free text', async () => {
    const r = await post({
      name: 'S', email: 'web-secret@example.com', agency_name: 'Secret Co', source: 'site', service_interest: 'website_improvement',
      message: 'login at /wp-admin password: hunter2 thanks', website_changes: 'pwd=abc123 please fix the header', website_issues: 'nothing else',
    })
    expect(r.status).toBe(200)
    const touch = await admin(db => db.one<{ body: string }>('select body from touches where prospect_id = $1', [r.json.id]))
    expect(touch?.body).not.toContain('hunter2')
    expect(touch?.body).toContain('[removed]')
    const eng = await admin(db => db.one<{ requested_changes: string; known_issues: string }>('select requested_changes, known_issues from website_engagements where prospect_id = $1', [r.json.id]))
    expect(eng?.requested_changes).not.toContain('abc123')
    expect(eng?.requested_changes).toContain('[removed]')
    expect(eng?.known_issues).toBe('nothing else')
    const details = await admin(db => db.one<{ website_details: Record<string, unknown> }>('select website_details from prospects where id = $1', [r.json.id]))
    expect(JSON.stringify(details?.website_details)).not.toMatch(/hunter2|abc123/)
  })

  it('rejects bad input and swallows honeypot', async () => {
    const { POST } = await import('../../app/api/public/lead/route')
    const bad = await POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '', email: 'nope', source: 'site' }) }))
    expect(bad.status).toBe(400)
    const bot = await POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'b', email: 'b@b.co', source: 'chat', website: 'spam' }) }))
    expect((await bot.json()).id).toBeNull()
  })
})
