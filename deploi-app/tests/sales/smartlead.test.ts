import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { handleSmartleadEvent } from '../../lib/sales/smartlead'

// tests/setup.ts forces .env.test; allow a per-section database for parallel section work
if (process.env.SALES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.SALES_TEST_DATABASE_URL
const ready = await prepareDb()
const EMAIL = 'smartlead-test@example.com'

describe.skipIf(!ready)('Smartlead webhook', () => {
  beforeAll(async () => { await admin(db => db.query('delete from prospects where lower(email) = $1', [EMAIL])) })
  afterAll(async () => { await admin(db => db.query('delete from prospects where lower(email) = $1', [EMAIL])) })

  it('rejects a bad secret when configured, accepts the right one', async () => {
    process.env.SMARTLEAD_WEBHOOK_SECRET = 'topsecret'
    const { POST } = await import('../../app/api/webhooks/smartlead/route')
    const mk = (headers: Record<string, string>, body: object) => new Request('http://localhost/api/webhooks/smartlead', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const bad = await POST(mk({ 'x-smartlead-secret': 'nope' }, { event_type: 'EMAIL_SENT', to_email: EMAIL }))
    expect(bad.status).toBe(401)
    const good = await POST(mk({ 'x-smartlead-secret': 'topsecret' }, { event_type: 'EMAIL_SENT', to_email: EMAIL, company_name: 'Smartlead Test Agency', subject: 'Hi' }))
    expect(good.status).toBe(200)
    const viaBody = await POST(mk({}, { event_type: 'EMAIL_SENT', to_email: EMAIL, secret_key: 'topsecret' }))
    expect(viaBody.status).toBe(200)
    process.env.SMARTLEAD_WEBHOOK_SECRET = ''
  })

  it('EMAIL_SENT creates an unknown prospect as contacted with an outbound touch', async () => {
    const p = await admin(db => db.one<{ id: string; stage: string; source: string }>('select id, stage::text as stage, source from prospects where lower(email) = $1', [EMAIL]))
    expect(p?.stage).toBe('contacted')
    expect(p?.source).toBe('smartlead')
    const t = await admin(db => db.query<{ direction: string }>('select direction from touches where prospect_id = $1', [p!.id]))
    expect(t.length).toBe(2)
    expect(t.every(x => x.direction === 'outbound')).toBe(true)
  })

  it('EMAIL_REPLIED writes an inbound touch and moves to replied', async () => {
    const r = await admin(db => handleSmartleadEvent(db, { event_type: 'EMAIL_REPLIED', to_email: EMAIL, reply_body: 'Sure, call me', subject: 'Re: Hi' }))
    expect(r.stage).toBe('replied')
    const t = await admin(db => db.one<{ body: string }>("select body from touches where prospect_id = $1 and direction = 'inbound'", [r.prospectId]))
    expect(t?.body).toBe('Sure, call me')
  })

  it('does not regress a prospect that is already further along', async () => {
    await admin(db => db.query("update prospects set stage = 'call_booked' where lower(email) = $1", [EMAIL]))
    const r = await admin(db => handleSmartleadEvent(db, { event_type: 'EMAIL_SENT', to_email: EMAIL }))
    expect(r.stage).toBe('call_booked')
  })

  it('EMAIL_BOUNCED flags email_invalid', async () => {
    await admin(db => handleSmartleadEvent(db, { event_type: 'EMAIL_BOUNCED', to_email: EMAIL }))
    const p = await admin(db => db.one<{ email_invalid: boolean }>('select email_invalid from prospects where lower(email) = $1', [EMAIL]))
    expect(p?.email_invalid).toBe(true)
  })

  it('LEAD_UNSUBSCRIBED moves to lost and appends a note', async () => {
    const r = await admin(db => handleSmartleadEvent(db, { event_type: 'LEAD_UNSUBSCRIBED', lead_email: EMAIL }))
    expect(r.stage).toBe('lost')
    const p = await admin(db => db.one<{ owner_notes: string }>('select owner_notes from prospects where lower(email) = $1', [EMAIL]))
    expect(p?.owner_notes).toContain('Unsubscribed')
  })

  it('ignores unknown events and unknown prospects on non-send events', async () => {
    expect((await admin(db => handleSmartleadEvent(db, { event_type: 'EMAIL_OPENED', to_email: EMAIL }))).handled).toBe(false)
    expect((await admin(db => handleSmartleadEvent(db, { event_type: 'EMAIL_REPLIED', to_email: 'nobody-here@example.com' }))).handled).toBe(false)
  })
})
