import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { recordQuote, scheduleJob } from '../../lib/packs/home-services'
import { injectPortFault, synthPay } from '../../lib/packs/synthetic'
import { PACK_AGENTS } from '../../lib/packs/registry'
import { NW, HB, resetPacks, fire, sweep, monday, plus, sentMail, one, rows, activity, owner, crew, setCrewMode, leadEmail, mutateSynth, getSynth } from './helpers'

const ready = await prepareDb()
const T = monday(2)
const newLead = (id: string, extra: Partial<Parameters<typeof leadEmail>[0]> = {}) => leadEmail({ id, from: 'forms@acme-roofing.example', name: 'Dana Reyes', email: 'dana@homeowner.example', text: 'My roof is leaking near the chimney.', subject: 'Roof repair request', ...extra })
const reply = (text: string, from = 'dana@homeowner.example') => ({ from, subject: 'Re: Your quote request', text, messageId: `r-${Math.random()}` })
async function crewMember(m = NW) { return (await admin(db => db.one<{ id: string }>(`insert into pack_crew_members (org_id, name, email, phone, trade) values ($1,'Sam Ortiz','sam@crew.example','+1 555 0100','roofing') returning id`, [m.org])))! }

describe.skipIf(!ready)('home services pack', () => {
  beforeEach(async () => { await resetPacks(NW, 'home_services', { trade: 'roofing', settings: { reviewUrl: 'https://reviews.example/acme' } }); await resetPacks(HB, null) })

  it('registers seven agents with honest status, none shown in the Shopify app', () => {
    const hs = PACK_AGENTS.filter(a => a.pack === 'home_services')
    expect(hs.map(a => a.key).sort()).toEqual(['hs_dispatch', 'hs_invoice', 'hs_lead_reply', 'hs_payment_chase', 'hs_quote_booking', 'hs_quote_followup', 'hs_review_request'])
    expect(hs.every(a => a.status === 'synthetic_only' && !a.shopifyReady && a.triggers.length && a.actions.length)).toBe(true)
  })

  it('replies to a new lead within the event with the trade template and three quote-visit times, verified at the mail provider', async () => {
    await fire(NW, 'lead.email', newLead('m-1'), T)
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(1)
    expect(mail[0].to).toBe('dana@homeowner.example')
    expect(mail[0].body).toMatch(/Hi Dana,/)
    expect(mail[0].body).toMatch(/water is coming in right now/) // the roofing template
    expect(mail[0].body.match(/^\d\. /gm)).toHaveLength(3)
    const lead = await one<{ status: string; proposed_slots: unknown[] }>(`select status, proposed_slots from pack_leads where org_id = $1`, [NW.org])
    expect(lead).toMatchObject({ status: 'slots_offered' })
    expect(lead!.proposed_slots).toHaveLength(3)
    const [a] = await activity(NW, 'hs_lead_reply')
    expect(a.status).toBe('done')
    expect(a.proof.map(p => p.label)).toEqual(expect.arrayContaining(['Content policy', 'Reply delivered to the provider']))
    expect(owner.some(u => u.agentKey === 'hs_lead_reply' && u.severity === 'info')).toBe(true)
  })

  it('uses each trade\'s own template', async () => {
    for (const [trade, line] of [['hvac', /no heat or no cooling/], ['cleaning', /fixed price/], ['landscaping', /walk the property/], ['construction', /take measurements/]] as const) {
      await resetPacks(NW, 'home_services', { trade })
      await fire(NW, 'lead.email', newLead(`m-${trade}`), T)
      expect((await sentMail(NW))[0].body).toMatch(line)
    }
  })

  it('the same lead message twice, and the same person again, never get a second reply', async () => {
    await fire(NW, 'lead.email', newLead('m-1'), T)
    await fire(NW, 'lead.email', newLead('m-1'), T)
    await fire(NW, 'lead.email', newLead('m-2', { text: 'Following up on my roof.' }), plus(T, 1))
    expect(await sentMail(NW)).toHaveLength(1)
    expect((await rows(`select status from pack_leads where org_id = $1 order by created_at`, [NW.org])).map(r => r.status)).toEqual(['slots_offered', 'duplicate'])
  })

  it('a lead without an email address is not replied to; the owner is told to call', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'm-3', from: 'leads@zillow.com', name: 'No Email', text: 'Phone: 555 0199' }), T)
    expect(await sentMail(NW)).toHaveLength(0)
    const [a] = await activity(NW, 'hs_lead_reply')
    expect(a).toMatchObject({ status: 'blocked' })
    expect(a.error).toMatch(/no email address/)
    expect(owner.find(u => u.agentKey === 'hs_lead_reply')!.severity).toBe('warning')
  })

  it('a full calendar still gets a reply (asking for times) and the owner hears it', async () => {
    await mutateSynth(NW.org, 'calendar', s => { s.busy = [{ start: T.toISOString(), end: plus(T, 24 * 20).toISOString() }] })
    await fire(NW, 'lead.email', newLead('m-4'), T)
    const [m] = await sentMail(NW)
    expect(m.body).toMatch(/calendar is full for the next 10 days/)
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('replied')
    expect(owner.some(u => u.whatIDid.some(l => /calendar is full/.test(l)))).toBe(true)
  })

  it('an unreachable mail provider leaves the lead unanswered, recorded and reported (nothing half-written)', async () => {
    await injectPortFault(NW.org, 'mail', { op: 'send', mode: 'unreachable' })
    await fire(NW, 'lead.email', newLead('m-5'), T)
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('new')
    expect((await activity(NW, 'hs_lead_reply'))[0].status).toBe('blocked')
    expect((await one(`select status from pack_messages where org_id = $1`, [NW.org]))).toBeNull() // rolled back with the failed act
  })

  it('a bounced reply is reported as not verified', async () => {
    await mutateSynth(NW.org, 'mail', s => { s.bounce = ['dana@homeowner.example'] })
    await fire(NW, 'lead.email', newLead('m-6'), T)
    expect((await activity(NW, 'hs_lead_reply'))[0].status).toBe('not_verified')
    expect(owner.find(u => u.agentKey === 'hs_lead_reply')!.severity).toBe('warning')
  })

  it('books the quote visit the customer picks, confirms it, and the calendar shows it', async () => {
    await fire(NW, 'lead.email', newLead('m-1'), T)
    await fire(NW, 'mail.received', reply('2 works for me, thanks'), plus(T, 1))
    const appt = await one<{ kind: string; calendar_event_id: string; starts_at: Date }>(`select kind, calendar_event_id, starts_at from pack_appointments where org_id = $1`, [NW.org])
    expect(appt!.kind).toBe('quote_visit')
    const cal = await getSynth(NW.org, 'calendar')
    expect(cal.events.map(e => e.id)).toEqual([appt!.calendar_event_id])
    const mail = await sentMail(NW)
    expect(mail[1].subject).toMatch(/^Confirmed: a free quote visit/)
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('booked')
    expect((await activity(NW, 'hs_quote_booking'))[0].proof.some(p => /Calendar event confirmed/.test(p.label))).toBe(true)
    // the same reply again books nothing new
    await fire(NW, 'mail.received', reply('2 works for me, thanks'), plus(T, 2))
    expect((await getSynth(NW.org, 'calendar')).events).toHaveLength(1)
  })

  it('a time taken in the meantime gets new times instead of a double booking', async () => {
    await fire(NW, 'lead.email', newLead('m-1'), T)
    const lead = (await one<{ proposed_slots: { start: string; end: string }[] }>(`select proposed_slots from pack_leads where org_id = $1`, [NW.org]))!
    await mutateSynth(NW.org, 'calendar', s => { s.busy.push({ start: lead.proposed_slots[0].start, end: lead.proposed_slots[0].end }) })
    await fire(NW, 'mail.received', reply('1'), plus(T, 1))
    expect(await rows(`select id from pack_appointments where org_id = $1`, [NW.org])).toHaveLength(0)
    expect((await sentMail(NW))[1].subject).toBe('Times that are still open')
  })

  it('a reply that picks no time books nothing', async () => {
    await fire(NW, 'lead.email', newLead('m-1'), T)
    await fire(NW, 'mail.received', reply('Can you do evenings?'), plus(T, 1))
    expect(await rows(`select id from pack_appointments where org_id = $1`, [NW.org])).toHaveLength(0)
  })

  it('follows up a quiet quote on the cadence, then marks it quiet and tells the owner', async () => {
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Re-roof', amount: 8400, now: T }))
    await sweep(NW, plus(T, 24 * 2)) // not due yet
    expect(await sentMail(NW)).toHaveLength(0)
    await sweep(NW, plus(T, 24 * 3))
    await sweep(NW, plus(T, 24 * 3 + 1)) // the same day again: no second note
    await sweep(NW, plus(T, 24 * 7))
    await sweep(NW, plus(T, 24 * 14))
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(3)
    expect(mail.every(m => m.subject.includes(wo.ref))).toBe(true)
    expect(mail[2].body).toMatch(/last note/)
    await sweep(NW, plus(T, 24 * 21))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('quiet')
    expect(owner.some(u => /went quiet/.test(u.headline))).toBe(true)
  })

  it('a YES to a quote accepts it and stops follow-ups; NO closes it', async () => {
    const a = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Gutters', amount: 900, now: T }))
    await fire(NW, 'mail.received', reply('Yes, go ahead please'), plus(T, 5))
    expect((await one(`select status, next_quote_follow_up_at from pack_work_orders where id = $1`, [a.id]))).toMatchObject({ status: 'accepted', next_quote_follow_up_at: null })
    const b = await admin(db => recordQuote(db, NW.org, { customerName: 'Lee', customerEmail: 'lee@homeowner.example', description: 'Shingles', amount: 400, now: T }))
    await fire(NW, 'mail.received', reply('No thanks, we went with someone else', 'lee@homeowner.example'), plus(T, 5))
    expect((await one(`select status from pack_work_orders where id = $1`, [b.id]))!.status).toBe('cancelled')
    await sweep(NW, plus(T, 24 * 30))
    expect(await sentMail(NW)).toHaveLength(0)
  })

  it('dispatches a scheduled job to its crew member with the details, and records the confirmation', async () => {
    const c = await crewMember()
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', customerPhone: '+1 555 0123', address: '12 Elm St', description: 'Replace flashing', amount: 650, now: T }))
    await admin(db => scheduleJob(db, NW.org, wo.id, { crewMemberId: c.id, start: plus(T, 30) }))
    await sweep(NW, T)
    expect(crew).toHaveLength(1)
    expect(crew[0]).toMatchObject({ crewMemberId: c.id, jobRef: wo.ref, address: '12 Elm St' })
    expect(crew[0].body).toMatch(/Where: 12 Elm St[\s\S]*Customer: Dana Reyes \(\+1 555 0123\)[\s\S]*Work: Replace flashing/)
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('dispatched')
    await sweep(NW, plus(T, 0.5))
    expect(crew).toHaveLength(1) // dispatched once
    await fire(NW, 'crew.confirmed', { jobRef: wo.ref }, plus(T, 1))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('confirmed')
    await sweep(NW, plus(T, 6))
    expect(crew).toHaveLength(1) // no reminder after a confirmation
  })

  it('a crew member who never confirms gets one reminder, then the owner is told', async () => {
    const c = await crewMember()
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', address: '12 Elm St', description: 'Fix', amount: 300, now: T }))
    await admin(db => scheduleJob(db, NW.org, wo.id, { crewMemberId: c.id, start: plus(T, 30) }))
    await sweep(NW, T)
    await sweep(NW, plus(T, 2.5))
    await sweep(NW, plus(T, 3))
    expect(crew.map(m => m.subject)).toEqual([expect.stringMatching(/^Job /), expect.stringMatching(/^Reminder: please confirm/)])
    await sweep(NW, plus(T, 4.5))
    await sweep(NW, plus(T, 5))
    expect(owner.filter(u => /has not confirmed job/.test(u.headline))).toHaveLength(1)
    expect((await one(`select crew_escalated_at from pack_work_orders where id = $1`, [wo.id]))!.crew_escalated_at).not.toBeNull()
  })

  it('a crew message that cannot be delivered is not counted as dispatched', async () => {
    const c = await crewMember()
    setCrewMode('skipped')
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Fix', amount: 300, now: T }))
    await admin(db => scheduleJob(db, NW.org, wo.id, { crewMemberId: c.id, start: plus(T, 30) }))
    await sweep(NW, T)
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('scheduled')
    expect((await activity(NW, 'hs_dispatch'))[0].status).toBe('not_verified')
  })

  it('DONE from the crew creates and sends the invoice once; a second DONE bills nothing', async () => {
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Replace flashing', amount: 650, now: T }))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, plus(T, 50))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, plus(T, 51))
    const inv = await getSynth(NW.org, 'invoicing')
    expect(inv.invoices).toHaveLength(1)
    expect(inv.invoices[0]).toMatchObject({ total: 650, balance: 650, billEmail: 'dana@homeowner.example', sentCount: 1 })
    const row = await one<{ status: string; invoice_number: string; invoice_due_date: Date }>(`select status, invoice_number, invoice_due_date from pack_work_orders where id = $1`, [wo.id])
    expect(row).toMatchObject({ status: 'invoiced', invoice_number: inv.invoices[0].number })
    expect((await activity(NW, 'hs_invoice')).map(a => a.status)).toEqual(['done'])
  })

  it('a job without a price is not invoiced; the owner is asked for the amount', async () => {
    const wo = await admin(db => db.one<{ ref: string; id: string }>(`insert into pack_work_orders (org_id, ref, customer_name, customer_email, description, status) values ($1,'J-1','Dana','dana@homeowner.example','Fix','scheduled') returning ref, id`, [NW.org]))
    await fire(NW, 'crew.done', { jobRef: wo!.ref }, T)
    expect((await getSynth(NW.org, 'invoicing')).invoices).toHaveLength(0)
    expect((await activity(NW, 'hs_invoice'))[0]).toMatchObject({ status: 'blocked' })
    expect((await activity(NW, 'hs_invoice'))[0].error).toMatch(/no price/)
  })

  it('chases a late invoice on the cadence, notes a part payment, marks it paid from a fresh read, then asks for a review', async () => {
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Re-roof', amount: 1000, now: T }))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, T) // due in 14 days
    const invId = (await getSynth(NW.org, 'invoicing')).invoices[0].id
    await sweep(NW, plus(T, 24 * 15)) // 1 day late: not yet
    expect(await sentMail(NW)).toHaveLength(0)
    await sweep(NW, plus(T, 24 * 17)) // 3 days late: reminder 1
    await synthPay(NW.org, invId, 400)
    await sweep(NW, plus(T, 24 * 24)) // 10 days late: reminder 2, with the new balance
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(2)
    expect(mail[0].body).toMatch(/balance still open is USD\s1,000\.00/)
    expect(mail[1].body).toMatch(/USD\s600\.00 of USD\s1,000\.00/)
    await synthPay(NW.org, invId, 600)
    await sweep(NW, plus(T, 24 * 25))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('paid')
    await sweep(NW, plus(T, 24 * 25 + 1))
    const last = (await sentMail(NW)).at(-1)!
    expect(last.subject).toMatch(/^Thank you from/)
    expect(last.body).toMatch(/https:\/\/reviews\.example\/acme/)
    await sweep(NW, plus(T, 24 * 40))
    expect(await sentMail(NW)).toHaveLength(3) // no more reminders, one review request
  })

  it('an invoice already paid before the first reminder gets no reminder', async () => {
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Fix', amount: 200, now: T }))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, T)
    await synthPay(NW.org, (await getSynth(NW.org, 'invoicing')).invoices[0].id, 200)
    await sweep(NW, plus(T, 24 * 20))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('paid')
    expect((await sentMail(NW)).filter(m => /overdue/.test(m.subject))).toHaveLength(0)
  })

  it('after every reminder the owner takes over a week later, once', async () => {
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Fix', amount: 200, now: T }))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, T)
    for (const d of [17, 24, 34, 38, 42, 43]) await sweep(NW, plus(T, 24 * d))
    expect((await sentMail(NW)).filter(m => /Invoice/.test(m.subject) || /^Re:/.test(m.subject))).toHaveLength(3)
    expect(owner.filter(u => /still unpaid after 3 reminders/.test(u.headline))).toHaveLength(1)
  })

  it('a review request without a review link waits for the owner', async () => {
    await resetPacks(NW, 'home_services', { trade: 'roofing' })
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Fix', amount: 200, now: T }))
    await admin(db => db.query(`update pack_work_orders set status = 'paid', paid_at = $2 where id = $1`, [wo.id, T.toISOString()]))
    await sweep(NW, plus(T, 1))
    expect((await activity(NW, 'hs_review_request'))[0]).toMatchObject({ status: 'blocked' })
    expect(await sentMail(NW)).toHaveLength(0)
  })

  it('does nothing for an organization without the pack', async () => {
    await fire(HB, 'lead.email', newLead('m-hb'), T)
    expect(await sentMail(HB)).toHaveLength(0)
    expect(await rows(`select id from pack_leads where org_id = $1`, [HB.org])).toHaveLength(0)
  })
})
