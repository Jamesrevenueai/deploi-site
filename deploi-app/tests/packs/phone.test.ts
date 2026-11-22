/**
 * Office phone agents (Track B): Missed Call Agent and Booking Agent, and the whole service-business chain on
 * synthetic ports and the simulated text sender: missed call -> text back -> the caller's need -> CRM lead ->
 * owner text with link -> times offered -> booked -> reminder the day before -> reschedule -> crew dispatched ->
 * DONE -> invoice sent -> payment follow-up -> paid. Also: the flag, STOP, webhooks (signatures, 404 when off),
 * and the Twilio adapter's test-mode guard.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.hoisted(() => { process.env.OFFICE_PHONE_AGENTS = 'on' })

import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { recordQuote, scheduleJob } from '../../lib/packs/home-services'
import { synthPay } from '../../lib/packs/synthetic'
import { PACK_AGENTS } from '../../lib/packs/registry'
import { setMyPrefs } from '../../lib/notify/preferences'
import { notifyOwnerImpl } from '../../lib/notify/owner'
import { setChannelAdapter } from '../../lib/notify/channels'
import { twilioAdapter, holdReason, twilioConfig, twilioSignature } from '../../lib/notify/twilio'
import { handleSmsWebhook, handleVoiceWebhook, deploiSignature } from '../../lib/packs/phone-webhook'
import { phoneAgentsOn, wantsReschedule, wantsCancel, STOP_WORDS } from '../../lib/packs/phone'
import { NW, resetPacks, fire, sweep, monday, plus, sentMail, one, rows, activity, owner, crewMember, crewSent, getSynth, merchantActor } from './helpers'

const ready = await prepareDb()
const T = monday(2) // a Monday 08:00 UTC
const CALLER = '+15550142777', LINE = '+15550109000'
let seq = 0
const missed = (at: Date, from = CALLER) => fire(NW, 'call.missed', { callId: `CA${++seq}`, from, to: LINE, status: 'no-answer' }, at)
const textIn = (body: string, at: Date, from = CALLER) => fire(NW, 'sms.received', { messageId: `SM${++seq}`, from, to: LINE, body }, at)
const texts = (to = CALLER) => rows<{ body: string; status: string; audience: string; provider: string }>(`select body, status, audience, provider from notify_outbox where org_id = $1 and to_phone = $2 order by created_at, id`, [NW.org, to])

async function resetPhone() {
  await resetPacks(NW, 'home_services', { trade: 'hvac' })
  await admin(async db => {
    for (const t of ['phone_texts', 'phone_calls', 'office_phone_lines', 'notify_outbox']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
    await db.query(`delete from agent_events where org_id = $1 and source in ('phone', 'crew')`, [NW.org])
    await db.query(`insert into office_phone_lines (org_id, phone_number, forward_to) values ($1, $2, null) on conflict (phone_number) do update set org_id = excluded.org_id, forward_to = null, active = true`, [NW.org, LINE])
  })
}

describe.skipIf(!ready)('office phone agents', () => {
  beforeEach(resetPhone)
  afterAll(() => { delete process.env.OFFICE_PHONE_AGENTS; delete process.env.PHONE_WEBHOOK_SECRET })

  it('registers the Missed Call Agent and the Booking Agent with honest status, not in the Shopify app', () => {
    expect(phoneAgentsOn()).toBe(true)
    const ph = PACK_AGENTS.filter(a => a.key.startsWith('ph_'))
    expect(ph.map(a => a.name).sort()).toEqual(['Booking Agent', 'Missed Call Agent'])
    expect(ph.every(a => a.status === 'synthetic_only' && !a.shopifyReady && a.pack === 'office')).toBe(true)
  })

  it('a missed call is texted back within a minute, once, with the time recorded as proof', async () => {
    const e = await missed(T)
    await fire(NW, 'call.missed', e.payload, plus(T, 0.001), e.externalId) // the same call delivered again
    const t = await texts()
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ audience: 'customer', status: 'simulated' })
    expect(t[0].body).toMatch(/Sorry we missed your call! What can we help you with\?.*Reply STOP to opt out/)
    const call = await one<{ state: string; lead_id: string }>(`select state, lead_id from phone_calls where org_id = $1`, [NW.org])
    expect(call!.state).toBe('texted')
    const [a] = await activity(NW, 'ph_missed_call')
    expect(a.status).toBe('done')
    const secs = Number(/(\d+) seconds/.exec(a.proof.find(p => /Time from the missed call/.test(p.label))!.value)![1])
    expect(secs).toBeLessThan(60)
  })

  it('the reply becomes a CRM lead, the owner is told with a link, and three times are offered', async () => {
    await missed(T)
    await textIn('My furnace stopped working, no heat upstairs', plus(T, 0.05))
    const lead = await one<{ id: string; status: string; subject: string; crm_record_id: string; proposed_slots: unknown[]; pack: string }>(`select * from pack_leads where org_id = $1 and source = 'phone'`, [NW.org])
    expect(lead).toMatchObject({ status: 'slots_offered', subject: 'My furnace stopped working, no heat upstairs', pack: 'home_services' })
    expect(lead!.proposed_slots).toHaveLength(3)
    const crm = await getSynth(NW.org, 'crm')
    expect(crm.contacts).toHaveLength(1)
    expect(crm.contacts[0]).toMatchObject({ id: lead!.crm_record_id, email: null, phone: CALLER, tags: ['missed call', 'phone'] })
    expect(crm.contacts[0].notes[0]).toMatch(/Needs: My furnace stopped working/)
    const t = await texts()
    expect(t).toHaveLength(2)
    expect(t[1].body.match(/^\d\) /gm)).toHaveLength(3)
    expect(t[1].body).toMatch(/Reply 1, 2 or 3 to book\./)
    const u = owner.find(x => x.agentKey === 'ph_missed_call' && /New lead from a missed call/.test(x.headline))!
    expect(u.detailsPath).toBe(`/store/packs/office?lead=${lead!.id}`)
  })

  it('the full chain for a service business: book, remind, reschedule, dispatch the crew, invoice, chase, paid; owner texts and voice notes carry links', async () => {
    // the owner wants texts and voice notes on their own phone
    const actor = await merchantActor(NW)
    await setMyPrefs(actor, { email: false, text: true, voice: true, phone: '+15550100999' })
    // 1. missed call -> text back
    await missed(T)
    // 2. what they need -> CRM lead + times
    await textIn('AC is blowing warm air', plus(T, 0.05))
    const lead = (await one<{ id: string; proposed_slots: { start: string; label: string }[] }>(`select * from pack_leads where org_id = $1 and source = 'phone'`, [NW.org]))!
    // 3. books option 2
    await textIn('2', plus(T, 0.2))
    const appt = (await one<{ id: string; starts_at: Date; status: string; calendar_event_id: string }>(`select * from pack_appointments where org_id = $1 and status = 'booked'`, [NW.org]))!
    expect(new Date(appt.starts_at).toISOString()).toBe(new Date(lead.proposed_slots[1].start).toISOString())
    expect((await getSynth(NW.org, 'calendar')).events.find(e => e.id === appt.calendar_event_id)!.status).toBe('confirmed')
    expect((await texts()).at(-1)!.body).toMatch(/You're booked with .* We'll text a reminder the day before\./)
    // 4. reschedule -> old event cancelled, new times, books option 1
    await textIn('Something came up, can I reschedule?', plus(T, 1))
    expect((await getSynth(NW.org, 'calendar')).events.find(e => e.id === appt.calendar_event_id)!.status).toBe('cancelled')
    expect((await texts()).at(-1)!.body).toMatch(/^No problem\. [\s\S]*can come out at:/)
    await textIn('1', plus(T, 1.1))
    const booked = (await one<{ id: string; starts_at: Date }>(`select * from pack_appointments where org_id = $1 and status = 'booked'`, [NW.org]))!
    expect(booked.id).not.toBe(appt.id)
    // 5. the day before: one reminder
    const dayBefore = plus(new Date(booked.starts_at), -23)
    await sweep(NW, dayBefore)
    await sweep(NW, plus(dayBefore, 1))
    expect((await texts()).filter(t => /^Reminder:/.test(t.body))).toHaveLength(1)
    expect((await one<{ reminder_sent_at: Date | null }>(`select reminder_sent_at from pack_appointments where id = $1`, [booked.id]))!.reminder_sent_at).not.toBeNull()
    // 6. the visit -> quote -> scheduled with a crew member -> dispatched
    const crew = await crewMember(NW, { name: 'Jo Tech', phone: '+15550100777' })
    const wo = await admin(db => recordQuote(db, NW.org, { leadId: lead.id, customerName: 'Pat Caller', customerEmail: 'pat@homeowner.example', address: '4 Oak Ave', description: 'Recharge AC and replace capacitor', amount: 480, now: plus(T, 48) }))
    await fire(NW, 'mail.received', { from: 'pat@homeowner.example', subject: 'Re: Your quote', text: 'Yes, go ahead', messageId: `q-${seq++}` }, plus(T, 49))
    await admin(db => scheduleJob(db, NW.org, wo.id, { crewMemberId: crew.id, start: plus(T, 72) }))
    await sweep(NW, plus(T, 50))
    const dispatched = await crewSent(NW)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].body).toMatch(/4 Oak Ave/)
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('dispatched')
    // 7. the crew texts DONE to the business line -> invoice created and sent
    await admin(db => db.query(`update crew_members set channels = array['email','text']::text[] where id = $1`, [crew.id]))
    const job = (await one<{ job_date: Date }>(`select job_date from crew_jobs where org_id = $1`, [NW.org]))!
    vi.setSystemTime(new Date(`${new Date(job.job_date).toISOString().slice(0, 10)}T15:00:00Z`))
    process.env.PHONE_WEBHOOK_SECRET = 'test-secret-0123456789'
    const raw = new URLSearchParams({ MessageSid: 'SMdone1', From: '+15550100777', To: LINE, Body: 'DONE' }).toString()
    const r = await handleSmsWebhook(raw, { twilio: null, deploi: deploiSignature('test-secret-0123456789', raw) })
    vi.useRealTimers()
    expect(r.status).toBe(200)
    const doneEvent = await one<{ id: string }>(`select id from agent_events where org_id = $1 and type = 'crew.done' order by received_at desc limit 1`, [NW.org])
    expect(doneEvent).not.toBeNull()
    await fire(NW, 'crew.done', { jobRef: wo.ref }, plus(T, 80)) // the queued event, delivered here directly
    const inv = await getSynth(NW.org, 'invoicing')
    expect(inv.invoices).toHaveLength(1)
    expect(inv.invoices[0]).toMatchObject({ total: 480, billEmail: 'pat@homeowner.example', sentCount: 1 })
    // 8. payment follow-up: late -> reminder; paid -> marked paid
    await sweep(NW, plus(T, 80 + 24 * 17))
    expect((await sentMail(NW)).filter(m => /overdue|reminder/i.test(m.subject + m.body))).not.toHaveLength(0)
    await synthPay(NW.org, inv.invoices[0].id, 480)
    await sweep(NW, plus(T, 80 + 24 * 18))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('paid')
    // 9. every owner update along the way, replayed through the real owner pipeline: a text and a voice note with the link
    const lead1 = owner.find(u => u.agentKey === 'ph_missed_call' && /New lead/.test(u.headline))!
    const res = await notifyOwnerImpl(lead1)
    expect(res.status).not.toBe('failed')
    const ownerMsgs = await texts('+15550100999')
    expect(ownerMsgs.map(m => m.status)).toEqual(['simulated', 'simulated'])
    expect(ownerMsgs[0].body).toMatch(new RegExp(`Missed Call Agent: New lead from a missed call: AC is blowing warm air\\..*Details: \\S+/store/packs/office\\?lead=${lead.id}`))
    const voice = await one<{ transcript: string }>(`select transcript from notify_outbox where org_id = $1 and to_phone = '+15550100999' and channel = 'voice'`, [NW.org])
    expect(voice!.transcript).toMatch(/the link in your messages/)
    const agents = new Set(owner.map(u => u.agentKey))
    for (const k of ['ph_missed_call', 'ph_booking', 'hs_dispatch', 'hs_invoice', 'hs_payment_chase']) expect(agents.has(k)).toBe(true)
  })

  it('a booked caller can cancel; the event is cancelled and they get one text', async () => {
    await missed(T)
    await textIn('Need a quote for a new heat pump', plus(T, 0.05))
    await textIn('option 3', plus(T, 0.1))
    await textIn('Please cancel the appointment', plus(T, 2))
    expect((await one(`select status from pack_appointments where org_id = $1`, [NW.org]))!.status).toBe('cancelled')
    expect((await one(`select status from pack_leads where org_id = $1 and source = 'phone'`, [NW.org]))!.status).toBe('lost')
    expect((await texts()).at(-1)!.body).toMatch(/is cancelled\. Text us any time/)
  })

  it('STOP closes the lead and nothing else is texted to that number, even after another missed call', async () => {
    await missed(T)
    await textIn('STOP', plus(T, 0.05))
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('stopped')
    await missed(plus(T, 5))
    await textIn('hello?', plus(T, 5.1))
    expect(await texts()).toHaveLength(1)
  })

  it('a full calendar: the caller is not left hanging, the owner is told to call them', async () => {
    const { mutateSynth } = await import('../../lib/packs/synthetic')
    await mutateSynth(NW.org, 'calendar', s => { s.busy = [{ start: T.toISOString(), end: plus(T, 24 * 20).toISOString() }] })
    await missed(T)
    await textIn('Water heater leaking', plus(T, 0.05))
    const offer = (await activity(NW, 'ph_booking'))[0]
    expect(offer.status).toBe('blocked')
    expect(offer.error).toMatch(/calendar is full .* call \+15550142777/)
    expect(owner.some(u => u.agentKey === 'ph_booking' && u.severity === 'warning')).toBe(true)
  })

  it('a held sender (live sends off) blocks the text back and tells the owner to call; nothing is marked texted', async () => {
    setChannelAdapter(twilioAdapter({ TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'x'.repeat(32), TWILIO_FROM_NUMBER: LINE }))
    try {
      await missed(T)
      // the blocked act is rolled back whole (nothing half-written): no text recorded as sent, the call still open
      expect(await texts()).toHaveLength(0)
      expect((await one(`select state from phone_calls where org_id = $1`, [NW.org]))!.state).toBe('new')
      const [a] = await activity(NW, 'ph_missed_call')
      expect(a.status).toBe('blocked')
      expect(a.error).toMatch(/was held \(live sends are off.*call them back on \+15550142777/)
      expect(owner.some(u => u.agentKey === 'ph_missed_call' && u.severity === 'warning')).toBe(true)
    } finally { setChannelAdapter(null) }
  })

  it('words: reschedule, cancel and STOP', () => {
    for (const t of ['can I reschedule', 'R', 'need a different time', "can't make it"]) expect(wantsReschedule(t)).toBe(true)
    expect(wantsCancel('cancel it please')).toBe(true)
    expect(wantsCancel('cancel and reschedule')).toBe(false)
    for (const t of ['STOP', 'stop.', 'Unsubscribe']) expect(STOP_WORDS.test(t)).toBe(true)
    expect(STOP_WORDS.test("don't stop the visit")).toBe(false)
  })
})

describe.skipIf(!ready)('phone webhooks', () => {
  beforeEach(resetPhone)
  afterAll(() => { delete process.env.PHONE_WEBHOOK_SECRET })
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

  it('fail closed: 404 when the flag is off, 503 without a secret, 401 on a bad signature', async () => {
    const raw = form({ CallSid: 'CA-x', From: CALLER, To: LINE, CallStatus: 'ringing' })
    expect((await handleVoiceWebhook(raw, { twilio: null, deploi: null }, { OFFICE_PHONE_AGENTS: 'off' })).status).toBe(404)
    expect((await handleVoiceWebhook(raw, { twilio: null, deploi: null }, { OFFICE_PHONE_AGENTS: 'on' })).status).toBe(503)
    expect((await handleVoiceWebhook(raw, { twilio: null, deploi: 'nope' }, { OFFICE_PHONE_AGENTS: 'on', PHONE_WEBHOOK_SECRET: 's'.repeat(20) })).status).toBe(401)
    const tw = { OFFICE_PHONE_AGENTS: 'on', TWILIO_AUTH_TOKEN: 't'.repeat(32), NEXT_PUBLIC_APP_URL: 'https://app.example' }
    expect((await handleVoiceWebhook(raw, { twilio: 'forged', deploi: null }, tw)).status).toBe(401)
  })

  it('a Twilio-signed unanswered dial becomes one missed-call event (a retried delivery is a duplicate)', async () => {
    const env = { OFFICE_PHONE_AGENTS: 'on', TWILIO_AUTH_TOKEN: 't'.repeat(32), NEXT_PUBLIC_APP_URL: 'https://app.example' }
    const p = { CallSid: 'CA-dial-1', From: CALLER, To: LINE, CallStatus: 'completed', DialCallStatus: 'no-answer' }
    const sig = twilioSignature(env.TWILIO_AUTH_TOKEN, 'https://app.example/api/webhooks/phone/voice', p)
    const r = await handleVoiceWebhook(form(p), { twilio: sig, deploi: null }, env)
    expect(r).toMatchObject({ status: 200, contentType: 'text/xml' })
    expect(r.body).toMatch(/<Say[^>]*>Sorry we missed you\. We&apos;ll text you right away\.<\/Say><Hangup\/>/)
    await handleVoiceWebhook(form(p), { twilio: sig, deploi: null }, env)
    const ev = await rows<{ type: string; duplicates: number; source: string }>(`select type, duplicates, source from agent_events where org_id = $1 and external_id = 'call:CA-dial-1'`, [NW.org])
    expect(ev).toEqual([{ type: 'call.missed', duplicates: 1, source: 'phone' }])
  })

  it('with a forwarding phone the call rings the owner first; an unknown number is ignored', async () => {
    await admin(db => db.query(`update office_phone_lines set forward_to = '+15550100999' where phone_number = $1`, [LINE]))
    const env = { OFFICE_PHONE_AGENTS: 'on', PHONE_WEBHOOK_SECRET: 's'.repeat(20), NEXT_PUBLIC_APP_URL: 'https://app.example' }
    const raw = form({ CallSid: 'CA-ring', From: CALLER, To: LINE, CallStatus: 'ringing' })
    const r = await handleVoiceWebhook(raw, { twilio: null, deploi: deploiSignature(env.PHONE_WEBHOOK_SECRET, raw) }, env)
    expect(r.body).toContain('<Dial timeout="20" action="https://app.example/api/webhooks/phone/voice">+15550100999</Dial>')
    const raw2 = form({ CallSid: 'CA-unknown', From: CALLER, To: '+15550000001', CallStatus: 'no-answer' })
    await handleVoiceWebhook(raw2, { twilio: null, deploi: deploiSignature(env.PHONE_WEBHOOK_SECRET, raw2) }, env)
    expect(await rows(`select 1 from agent_events where external_id in ('call:CA-ring', 'call:CA-unknown')`)).toHaveLength(0)
  })

  it('an inbound text becomes one sms.received event for the line\'s organization', async () => {
    const env = { OFFICE_PHONE_AGENTS: 'on', PHONE_WEBHOOK_SECRET: 's'.repeat(20) }
    const raw = form({ MessageSid: 'SM-1', From: CALLER, To: LINE, Body: 'Hi, I need a quote' })
    const r = await handleSmsWebhook(raw, { twilio: null, deploi: deploiSignature(env.PHONE_WEBHOOK_SECRET, raw) }, env)
    expect(r.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
    expect(await rows(`select type, source from agent_events where org_id = $1 and external_id = 'sms:SM-1'`, [NW.org])).toEqual([{ type: 'sms.received', source: 'phone' }])
  })
})

describe('Twilio adapter guard (no network)', () => {
  const base = { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'k'.repeat(32), TWILIO_FROM_NUMBER: '+15550109000' }
  it('holds everything until live sends are on, and in test mode reaches only the allowed numbers', () => {
    expect(holdReason(twilioConfig({}), '+15551112222', 'text')).toMatch(/not set up/)
    expect(holdReason(twilioConfig(base), '+15551112222', 'text')).toMatch(/live sends are off/)
    const test = twilioConfig({ ...base, NOTIFY_LIVE_SENDS: 'on', NOTIFY_ALLOWED_NUMBERS: '+15551112222' })
    expect(holdReason(test, '+15551112222', 'text')).toBeNull()
    expect(holdReason(test, '+15553334444', 'voice')).toMatch(/not in NOTIFY_ALLOWED_NUMBERS/)
  })
  it.skipIf(!ready)('sends to Twilio with basic auth, records the message id, and never sends twice', async () => {
    const calls: { url: string; body: string; auth: string }[] = []
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization) }); return new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }) }) as unknown as typeof fetch
    const a = twilioAdapter({ ...base, NOTIFY_LIVE_SENDS: 'on', NOTIFY_ALLOWED_NUMBERS: '+15551112222' }, fake)
    await admin(db => db.query(`delete from notify_outbox where org_id = $1`, [NW.org]))
    const m = { orgId: NW.org, audience: 'owner' as const, recipientRef: null, toPhone: '+15551112222', dedupeKey: 'tw-1', body: 'Hello from the test' }
    const r1 = await admin(db => a.sendText(db, m)), r2 = await admin(db => a.sendText(db, m))
    expect(r1).toMatchObject({ status: 'sent', duplicate: false })
    expect(r2).toMatchObject({ status: 'sent', duplicate: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${base.TWILIO_ACCOUNT_SID}/Messages.json`)
    expect(new URLSearchParams(calls[0].body).get('Body')).toBe('Hello from the test')
    expect(calls[0].auth).toMatch(/^Basic /)
    expect((await one<{ provider_message_id: string }>(`select provider_message_id from notify_outbox where org_id = $1 and dedupe_key = 'tw-1'`, [NW.org]))!.provider_message_id).toBe('SM123')
  })
})

describe.skipIf(!ready)('phone line setting', () => {
  beforeEach(async () => { process.env.OFFICE_PHONE_AGENTS = 'on'; await resetPhone() })
  afterAll(() => { delete process.env.OFFICE_PHONE_AGENTS })
  it('an owner sets the Deploi number and the phone that rings first; another business cannot take the number; flag off refuses', async () => {
    const { setPhoneLine } = await import('../../lib/packs/phone')
    const { HB } = await import('./helpers')
    const actor = await merchantActor(NW)
    const r = await setPhoneLine(actor, { phoneNumber: '+1 555 010 9001', forwardTo: '+1 (555) 010-0999' })
    expect(r).toMatchObject({ phoneNumber: '+15550109001', forwardTo: '+15550100999' })
    await expect(setPhoneLine(await merchantActor(HB), { phoneNumber: '+15550109001' })).rejects.toThrow(/already connected to another business/)
    await expect(setPhoneLine(actor, { phoneNumber: '0109001' })).rejects.toThrow(/international form/)
    process.env.OFFICE_PHONE_AGENTS = 'off'
    try { await expect(setPhoneLine(actor, { phoneNumber: '+15550109002' })).rejects.toThrow(/not switched on/) } finally { process.env.OFFICE_PHONE_AGENTS = 'on' }
    await admin(db => db.query(`delete from office_phone_lines where phone_number = '+15550109001'`))
  })
})

describe.skipIf(!ready)('privacy: a caller\'s phone data', () => {
  beforeEach(async () => { process.env.OFFICE_PHONE_AGENTS = 'on'; await resetPhone() })
  afterAll(() => { delete process.env.OFFICE_PHONE_AGENTS })
  it('exported and erased by phone number (customers/redact with customer.phone)', async () => {
    const { collectCustomerData, redactCustomerData } = await import('../../lib/privacy/customer-data')
    await missed(T)
    await textIn('Leaking pipe under the sink', plus(T, 0.05))
    const subject = { orgId: NW.org, email: null, customerId: null, orderIds: [], phone: CALLER }
    const data = await admin(db => collectCustomerData(db, subject, 'northwind.myshopify.com'))
    const t = data.tables as Record<string, unknown[]>
    expect(t.phone_calls).toHaveLength(1)
    expect(t.phone_texts).toHaveLength(1)
    const out = await admin(db => redactCustomerData(db, subject))
    expect(out).toMatchObject({ phone_calls: 1, phone_texts: 1, pack_leads_by_phone: 1 })
    expect(await rows(`select 1 from phone_calls where org_id = $1`, [NW.org])).toHaveLength(0)
    expect(await one(`select phone, subject from pack_leads where org_id = $1 and source = 'phone'`, [NW.org])).toEqual({ phone: null, subject: null })
  })
})

describe.skipIf(!ready)('office pack page: phone line', () => {
  beforeEach(resetPhone)
  afterAll(() => { delete process.env.OFFICE_PHONE_AGENTS })
  it('the Office pack view lists the line and recent missed calls while the flag is on, and nothing while it is off; the page op sets it', async () => {
    const { packView, packWrite } = await import('../../lib/packs/dashboard')
    const actor = await merchantActor(NW)
    process.env.OFFICE_PHONE_AGENTS = 'on'
    await missed(T)
    await packWrite(actor, 'phone-line', { phoneNumber: LINE, forwardTo: '+15550100999' })
    const on = await packView(actor, 'office')
    expect(on.records.phoneLines).toEqual([expect.objectContaining({ phone_number: LINE, forward_to: '+15550100999', active: true })])
    expect(on.records.calls).toEqual([expect.objectContaining({ from_phone: CALLER, state: 'texted' })])
    process.env.OFFICE_PHONE_AGENTS = 'off'
    const off = await packView(actor, 'office')
    expect(off.records.phoneLines).toBeNull()
    expect(off.records.calls).toBeNull()
  })
})
