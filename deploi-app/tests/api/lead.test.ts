import { describe, it, expect } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'

const ready = await prepareDb()

describe.skipIf(!ready)('POST /api/public/lead', () => {
  it('creates a prospect with source=site and a touch, dedupes on email + agency', async () => {
    const { POST, OPTIONS } = await import('../../app/api/public/lead/route')
    const body = { name: 'Lead Tester', email: 'lead-test@example.com', agency_name: 'Lead Test Agency', message: 'help', source: 'site' }
    const req = () => new Request('http://localhost/api/public/lead', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://getdeploi.com' }, body: JSON.stringify(body) })
    const r1 = await POST(req())
    const j1 = await r1.json()
    expect(r1.status).toBe(200)
    expect(j1.ok).toBe(true)
    expect(r1.headers.get('access-control-allow-origin')).toBe('https://getdeploi.com')
    const r2 = await POST(req())
    const j2 = await r2.json()
    expect(j2.id).toBe(j1.id)
    const touches = await admin(db => db.query('select id from touches where prospect_id = $1', [j1.id]))
    expect(touches.length).toBe(2)
    const lead = await admin(db => db.one<{ source: string }>('select source from leads where id = $1', [j1.id]))
    expect(lead?.source).toBe('site')
    const pre = await OPTIONS(new Request('http://localhost/api/public/lead', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    await admin(db => db.query('delete from prospects where id = $1', [j1.id]))
  })
  it('rejects bad input and swallows honeypot', async () => {
    const { POST } = await import('../../app/api/public/lead/route')
    const bad = await POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '', email: 'nope', source: 'site' }) }))
    expect(bad.status).toBe(400)
    const bot = await POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'b', email: 'b@b.co', source: 'chat', website: 'spam' }) }))
    expect((await bot.json()).id).toBeNull()
  })
})
