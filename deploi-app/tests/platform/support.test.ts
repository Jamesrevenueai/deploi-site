/**
 * Support: a customer opens a ticket from "Get help" (category, message, optional case reference), staff are told
 * through the system mailer, staff reply (emailed to the customer and shown in the customer's own view), and
 * tickets are isolated per organization by RLS and by every query. The public contact form is rate limited.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { NW, HB, merchantActor, staffActor } from '../merchant/helpers'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { createTicket, customerReply, getTicket, listTickets, staffGetTicket, staffListTickets, staffReply, staffSetStatus } from '../../lib/support/tickets'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'

const ready = await prepareDb()
const sent: { to: string[]; subject: string; text: string; reply_to?: string }[] = []

let cookie = ''
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookie ? { value: cookie } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))
const allowDev = process.env.ALLOW_DEV_LOGIN
process.env.ALLOW_DEV_LOGIN = 'true'
afterAll(() => { if (allowDev === undefined) delete process.env.ALLOW_DEV_LOGIN; else process.env.ALLOW_DEV_LOGIN = allowDev })
const contact = await import('../../app/api/public/contact/route')
const supportApi = await import('../../app/api/store/support/route')
const staffApi = await import('../../app/api/staff/support/route')
const as = (s: typeof SESSIONS.northwind | null) => { cookie = s ? encodeDevSession(s) : '' }
const req = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost:3000${path}`, body === undefined ? { headers } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers } })

async function clean() {
  await admin(async db => {
    await db.query('delete from support_tickets where org_id = any($1)', [[NW.org, HB.org]])
    await db.query(`delete from system_emails where template like 'support_%' or template = 'contact_staff'`)
    await db.query(`delete from contact_messages where email like '%@contact-test.example'`)
    await db.query(`delete from rate_limits where bucket = 'contact'`)
  })
}

describe.skipIf(!ready)('support tickets', () => {
  beforeEach(async () => {
    await clean()
    sent.length = 0
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.EMAIL_LIVE_SENDS = 'all'
    process.env.SUPPORT_INBOX = 'support@getdeploi.test'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.deploi.test'
    setEmailFetch(async (url, init) => {
      if (!url.endsWith('/emails')) throw new Error(`unexpected HTTP call in test: ${url}`)
      sent.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 })
    })
  })
  afterEach(async () => {
    setEmailFetch(null)
    for (const k of ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'SUPPORT_INBOX', 'NEXT_PUBLIC_APP_URL']) delete process.env[k]
    as(null)
    await clean()
  })

  it('a customer asks for help about one of their cases; staff are emailed; the request is in their own list', async () => {
    const nw = await merchantActor(NW)
    const c = await admin(db => db.one<{ ref: string }>(`insert into cases (org_id, kind, suite, source_app, dedupe_key, title, problem) values ($1, 'isolation_test', 'commerce', 'import', $2, 'Help case', 'x') returning ref`, [NW.org, `support-test-${Date.now()}`]))
    const r = await createTicket(nw, { category: 'agent', message: 'The Inventory Watcher drafted a change I did not expect.\nWhy?', caseRef: c!.ref.toLowerCase(), page: '/store/work' })
    expect(r.ticket).toMatchObject({ category: 'agent', subject: 'The Inventory Watcher drafted a change I did not expect.', caseRef: c!.ref, status: 'open', createdByEmail: NW.email })
    expect(r.ticket.ref).toMatch(/^SUP-[0-9A-F]{8}$/)
    expect(r.staffNotified).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['support@getdeploi.test'])
    expect(sent[0].reply_to).toBe(NW.email)
    expect(sent[0].subject).toBe(`[${r.ticket.ref}] An agent did something unexpected: The Inventory Watcher drafted a change I did not expect.`)
    expect(sent[0].text).toContain(`Case: ${c!.ref}`)
    expect(sent[0].text).toContain(`https://app.deploi.test/staff/support?ticket=${r.ticket.id}`)
    expect((await listTickets(nw)).map(t => t.id)).toEqual([r.ticket.id])
    // a case reference must be one of the organization's own cases
    const hbCase = await admin(db => db.one<{ ref: string }>(`insert into cases (org_id, kind, suite, source_app, dedupe_key, title, problem) values ($1, 'isolation_test', 'commerce', 'import', $2, 'HB case', 'x') returning ref`, [HB.org, `support-test-hb-${Date.now()}`]))
    await expect(createTicket(nw, { category: 'problem', message: 'x', caseRef: hbCase!.ref })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createTicket(nw, { category: 'nonsense', message: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createTicket(nw, { category: 'question', message: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await admin(db => db.query(`delete from cases where dedupe_key like 'support-test-%'`))
  })

  it('isolation: another organization reads none of it, through the library, the API or the database (RLS)', async () => {
    const t = (await createTicket(await merchantActor(NW), { category: 'question', message: 'Private to Northwind' })).ticket
    const hb = await merchantActor(HB)
    expect(await listTickets(hb)).toEqual([])
    await expect(getTicket(hb, t.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(customerReply(hb, t.id, 'sneaky')).rejects.toMatchObject({ code: 'not_found' })
    // the database itself, as Harbor's signed-in session
    expect(await withUser(SESSIONS.harbor, db => db.query('select id from support_tickets'))).toEqual([])
    expect(await withUser(SESSIONS.harbor, db => db.query('select id from support_messages'))).toEqual([])
    expect((await withUser(SESSIONS.northwind, db => db.query<{ id: string }>('select id from support_tickets'))).map(r => r.id)).toEqual([t.id])
    await expect(withUser(SESSIONS.northwind, db => db.query(`insert into support_tickets (org_id, ref, created_by_email, category, subject) values ($1, 'SUP-X', 'x', 'other', 'x')`, [HB.org]))).rejects.toThrow(/permission denied/)
    // the API
    as(SESSIONS.harbor)
    const list = await (await supportApi.GET(req('/api/store/support'))).json()
    expect(list.tickets).toEqual([])
    expect((await supportApi.GET(req(`/api/store/support?ticket=${t.id}`))).status).toBe(404)
    as(SESSIONS.northwind)
    expect((await (await supportApi.GET(req(`/api/store/support?ticket=${t.id}`))).json()).ticket.id).toBe(t.id)
    expect((await staffApi.GET(req('/api/staff/support'))).status).toBe(403) // customers never reach the staff desk
  })

  it('staff reply: emailed to the customer, shown in the customer\'s view, status updated; staff cannot open tickets for customers', async () => {
    const nw = await merchantActor(NW)
    const t = (await createTicket(nw, { category: 'billing', message: 'Where is my invoice?' })).ticket
    const staff = await staffActor()
    expect((await staffListTickets(staff)).find(x => x.id === t.id)).toMatchObject({ orgName: expect.any(String), status: 'open' })
    const after = await staffReply(staff, t.id, 'It is under Billing → Invoices.')
    expect(after.ticket.status).toBe('waiting_on_customer')
    const reply = sent.find(m => m.to[0] === NW.email)!
    expect(reply.subject).toBe(`Re: [${t.ref}] Where is my invoice?`)
    expect(reply.text).toContain('It is under Billing → Invoices.')
    expect(reply.text).toContain(`https://app.deploi.test/store/support?ticket=${t.id}`)
    expect(after.messages.at(-1)).toMatchObject({ authorKind: 'staff', emailStatus: 'sent' })
    const mine = await getTicket(nw, t.id)
    expect(mine.messages.map(m => [m.authorKind, m.body])).toEqual([['customer', 'Where is my invoice?'], ['staff', 'It is under Billing → Invoices.']])
    expect(mine.ticket.status).toBe('waiting_on_customer')
    // the customer answers: open again, staff told
    await customerReply(nw, t.id, 'Found it, thanks.')
    expect((await getTicket(nw, t.id)).ticket.status).toBe('open')
    expect(sent.at(-1)!.to).toEqual(['support@getdeploi.test'])
    expect((await staffSetStatus(staff, t.id, 'resolved')).ticket.status).toBe('resolved')
    await expect(staffSetStatus(staff, t.id, 'vanished')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createTicket(staff, { category: 'question', message: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(staffReply(nw, t.id, 'customer pretending')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(staffGetTicket(nw, t.id)).rejects.toMatchObject({ code: 'forbidden' })
    // through the staff API with a staff session (CSRF origin checked)
    as(SESSIONS.staff)
    const r = await staffApi.POST(req('/api/staff/support', { action: 'reply', ticketId: t.id, message: 'Anything else?' }))
    expect(r.status).toBe(200)
    expect((await staffApi.POST(req('/api/staff/support', { action: 'reply', ticketId: t.id, message: 'x' }, { origin: 'https://evil.example' }))).status).toBe(403)
  })

  it('the website contact form: stored for staff, staff emailed, bots dropped, rate limited per IP', async () => {
    const post = (body: unknown, ip = '198.51.100.7') => contact.POST(new Request('http://localhost:3000/api/public/contact', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'https://getdeploi.com', 'x-forwarded-for': ip } }))
    const ok = await post({ name: 'Sam', email: 'sam@contact-test.example', company: 'Sam & Co', topic: 'sales', message: 'Can we pilot? password: hunter2', elapsed_ms: 9000 })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://getdeploi.com')
    const row = await admin(db => db.one<{ message: string; topic: string }>(`select message, topic from contact_messages where email = 'sam@contact-test.example'`))
    expect(row!.topic).toBe('sales')
    expect(row!.message).not.toContain('hunter2')
    expect(sent.at(-1)).toMatchObject({ to: ['support@getdeploi.test'], subject: 'Website contact (sales) from Sam', reply_to: 'sam@contact-test.example' })
    // a bot (honeypot) is answered as accepted and dropped
    expect((await post({ name: 'Bot', email: 'bot@contact-test.example', message: 'spam', website: 'x' })).status).toBe(200)
    expect(await admin(db => db.one(`select 1 from contact_messages where email = 'bot@contact-test.example'`))).toBeNull()
    expect((await post({ name: 'x' })).status).toBe(400)
    // the limit counts every attempt from the IP, refused ones too
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await post({ name: 'Flood', email: 'flood@contact-test.example', message: 'x', elapsed_ms: 9000 }, '203.0.113.9')).status)
    expect(statuses.slice(0, 5).every(s => s === 200)).toBe(true)
    expect(statuses[5]).toBe(429)
  })
})
