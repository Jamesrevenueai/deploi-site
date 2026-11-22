if (process.env.WEB_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.WEB_TEST_DATABASE_URL
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const post = async (body: unknown, origin = 'https://getdeploi.com') => {
  const { POST } = await import('../../app/api/public/office-signup/route')
  const ip = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
  const r = await POST(new Request('http://localhost/api/public/office-signup', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip }, body: JSON.stringify(body) }))
  return { status: r.status, json: await r.json() as { ok: boolean; id: string | null } }
}
const EMAIL = 'owner@cool-air-hvac.example'
const body = { name: 'Pat Owner', email: EMAIL, company: 'Cool Air HVAC', phone: '+1 555 010 4455', business_type: 'home_services', trade: 'hvac', tools: ['outlook', 'quickbooks', 'hubspot'], message: 'We miss calls when we are on jobs', website: '', elapsed_ms: 9000 }

describe.skipIf(!ready)('POST /api/public/office-signup (service businesses)', () => {
  beforeEach(() => { process.env.OFFICE_SIGNUP = 'on' })
  afterAll(async () => { delete process.env.OFFICE_SIGNUP; await admin(db => db.query('delete from prospects where lower(email) = $1', [EMAIL])) })

  it('404 while the flag is off', async () => {
    delete process.env.OFFICE_SIGNUP
    expect((await post(body)).status).toBe(404)
  })

  it('creates a tagged prospect with the business type, trade, tools and phone; a repeat dedupes', async () => {
    const r = await post(body)
    expect(r.status).toBe(200)
    const p = await admin(db => db.one<{ agency_name: string; service_interest: string; tags: string[]; website_details: Record<string, unknown> }>('select agency_name, service_interest, tags, website_details from prospects where id = $1', [r.json.id]))
    expect(p).toMatchObject({ agency_name: 'Cool Air HVAC', service_interest: 'office_signup', website_details: { business_type: 'home_services', trade: 'hvac', tools: ['hubspot', 'outlook', 'quickbooks'], phone: '+15550104455' } })
    expect(p!.tags).toEqual(expect.arrayContaining(['Office sign-up', 'Home Services', 'Hvac']))
    expect((await post(body)).json.id).toBe(r.json.id)
  })

  it('refuses an unknown business type or tool; a bot (honeypot or too fast) is answered but not stored', async () => {
    expect((await post({ ...body, business_type: 'store' })).status).toBe(400)
    expect((await post({ ...body, tools: ['myspace'] })).status).toBe(400)
    await admin(db => db.query('delete from prospects where lower(email) = $1', [EMAIL]))
    expect((await post({ ...body, website: 'http://spam.example' })).json).toEqual({ ok: true, id: null })
    expect((await post({ ...body, elapsed_ms: 300 })).json).toEqual({ ok: true, id: null })
    expect(await admin(db => db.one('select 1 from prospects where lower(email) = $1', [EMAIL]))).toBeNull()
  })
})
