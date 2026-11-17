import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { commissionAmount, commissionCents, recordPlacement, recordPayment, weeklyTotals, undoPayment } from '../../lib/packs/commission'
import { answersIn, matchListings } from '../../lib/packs/leasing'
import { renterCriteria, parseDate } from '../../lib/packs/leads'
import { NW, resetPacks, fire, sweep, monday, plus, sentMail, one, rows, activity, owner, leadEmail } from './helpers'

const ready = await prepareDb()
const T = monday(2)
const day = (n: number) => new Date(T.getTime() + n * 864e5).toISOString().slice(0, 10)
const FIELDS = { Budget: '$2,000', 'Move-in': day(20), Bedrooms: '2', Pets: 'No' }

async function seedListings() {
  return admin(async db => {
    const co = (await db.one<{ id: string }>(`insert into leasing_companies (org_id, name, billing_email, contact_name) values ($1,'Harbor Property Group','ap@harborpg.example','Robin Lane') returning id`, [NW.org]))!
    const maple = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, company_id, name, commission_type, commission_value, payment_terms_days) values ($1,$2,'Maple Court','percent',50,30) returning id`, [NW.org, co.id]))!
    const birch = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name, billing_email, commission_type, commission_value) values ($1,'Birch Lofts','billing@birchlofts.example','flat',750) returning id`, [NW.org]))!
    const add = (p: string, unit: string, beds: number, rent: number, avail: string | null, pets: boolean, url: string | null = null) =>
      db.query(`insert into leasing_listings (org_id, property_id, unit, bedrooms, monthly_rent, available_from, pets_allowed, application_url) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [NW.org, p, unit, beds, rent, avail, pets, url])
    await add(maple.id, '4B', 2, 1950, day(10), false, 'https://apply.example/maple-4b')
    await add(maple.id, '2A', 2, 1800, null, true, 'https://apply.example/maple-2a')
    await add(birch.id, '301', 2, 2100, day(5), true) // over budget
    await add(birch.id, '105', 1, 1500, null, true) // wrong size
    await add(birch.id, '402', 2, 1700, day(40), false) // not available in time
    return { co: co.id, maple: maple.id, birch: birch.id }
  })
}

describe.skipIf(!ready)('leasing pack: renters', () => {
  beforeEach(async () => { await resetPacks(NW, 'leasing_agent', { settings: { applicationUrl: 'https://apply.example/general' } }); await seedListings() })

  it('reads only the labelled answers (budget, move-in, bedrooms, pets) from portal lead emails', () => {
    expect(renterCriteria('Name: A\nBudget: $2,000/mo\nMove-in date: December 1, 2026\nBeds: 2\nPets: Yes, a cat', '2026-11-06')).toEqual({ budget: 2000, moveIn: '2026-12-01', bedrooms: 2, pets: true })
    expect(renterCriteria('Max rent: 1.8k\nMove-in: 01/15/2027\nBedrooms: Studio\nPets: none', '2026-11-06')).toEqual({ budget: 1800, moveIn: '2027-01-15', bedrooms: 0, pets: false })
    // free text is never mined: "I have a dog and need 3 bedrooms" answers nothing
    expect(renterCriteria('Hi, I have a dog and need 3 bedrooms under $3000', '2026-11-06')).toEqual({ budget: null, moveIn: null, bedrooms: null, pets: null })
    expect(parseDate('Feb 3', '2026-11-06')).toBe('2027-02-03')
    expect(answersIn('1. 2500\n2) next year\n3. 2 beds\n4. no', ['budget', 'moveIn', 'bedrooms', 'pets'], '2026-11-06')).toEqual({ budget: 2500, bedrooms: 2, pets: false })
  })

  it('shows exactly the listings that match the stated criteria, cheapest first', async () => {
    const l = await admin(db => matchListings(db, NW.org, { budget: 2000, moveIn: day(20), bedrooms: 2, pets: false }))
    expect(l.map(x => x.unit)).toEqual(['2A', '4B'])
    const pets = await admin(db => matchListings(db, NW.org, { budget: 2000, moveIn: day(20), bedrooms: 2, pets: true }))
    expect(pets.map(x => x.unit)).toEqual(['2A'])
    expect(await admin(db => matchListings(db, NW.org, { budget: 2000, moveIn: null, bedrooms: 2, pets: false }))).toEqual([])
  })

  it('a complete lead gets the matching listings, three tour times and the application link, after the fair-housing check', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'z-1', name: 'Jordan Miles', email: 'jordan@renter.example', fields: FIELDS }), T)
    const [m] = await sentMail(NW)
    expect(m.subject).toMatch(/^Your rental inquiry with /)
    expect(m.body).toMatch(/Maple Court, unit 2A: 2 bedrooms, USD\s1,800\.00 a month/)
    expect(m.body).toMatch(/unit 4B[\s\S]*Apply: https:\/\/apply\.example\/maple-4b/)
    expect(m.body).not.toMatch(/301|105|402/)
    expect(m.body.match(/^\d\. /gm)).toHaveLength(3)
    expect(m.body).toMatch(/same questions and apply the same written criteria/)
    const msg = await one<{ policy: { ok: boolean; fairHousing: boolean } }>(`select policy from pack_messages where org_id = $1`, [NW.org])
    expect(msg!.policy).toMatchObject({ ok: true, fairHousing: true })
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('slots_offered')
  })

  it('an incomplete lead is asked only the standard questions it did not answer; the answers bring the listings', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'z-2', from: 'leads@apartments.com', name: 'Sam Park', email: 'sam@renter.example', fields: { Bedrooms: '2' } }), T)
    const [ask] = await sentMail(NW)
    expect(ask.body).toMatch(/1\. What is your monthly budget for rent\?\n2\. What date would you like to move in\?\n3\. Will any pets live with you\?/)
    expect(ask.body).not.toMatch(/How many bedrooms/)
    expect((await one(`select source, status from pack_leads where org_id = $1`, [NW.org]))).toMatchObject({ source: 'apartments_com', status: 'qualifying' })
    await fire(NW, 'mail.received', { from: 'sam@renter.example', subject: 'Re: Your rental inquiry', text: `1. $2,000\n2. ${day(20)}\n3. no\n\n> 1. What is your monthly budget for rent?`, messageId: 'r-1' }, plus(T, 2))
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(2)
    expect(mail[1].body).toMatch(/unit 2A[\s\S]*unit 4B/)
    expect((await activity(NW, 'ls_qualify'))[0].status).toBe('done')
  })

  it('books the tour the renter picks, confirms it with the application link, and reminds them the day before', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'z-3', name: 'Jordan Miles', email: 'jordan@renter.example', fields: FIELDS }), T)
    await fire(NW, 'mail.received', { from: 'jordan@renter.example', subject: 'Re: tour', text: 'Option 1 please', messageId: 'r-2' }, plus(T, 1))
    const appt = (await one<{ kind: string; starts_at: Date }>(`select kind, starts_at from pack_appointments where org_id = $1`, [NW.org]))!
    expect(appt.kind).toBe('tour')
    const mail = await sentMail(NW)
    expect(mail[1].subject).toMatch(/^Confirmed: an apartment tour/)
    expect(mail[1].body).toMatch(/apply online at any time: https:\/\/apply\.example\/general/)
    await sweep(NW, new Date(appt.starts_at.getTime() - 30 * 3600e3)) // too early
    await sweep(NW, new Date(appt.starts_at.getTime() - 20 * 3600e3))
    await sweep(NW, new Date(appt.starts_at.getTime() - 19 * 3600e3))
    const all = await sentMail(NW)
    expect(all.filter(m => /^Reminder: your tour/.test(m.subject))).toHaveLength(1)
  })

  it('a duplicate inquiry from the same renter is answered once, on the first lead', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'z-4', name: 'Sam Park', email: 'sam@renter.example', fields: { Bedrooms: '2' } }), T)
    await fire(NW, 'lead.email', leadEmail({ id: 'z-5', from: 'leads@zumper.com', name: 'Sam Park', email: 'sam@renter.example', fields: { Bedrooms: '2' } }), plus(T, 1))
    expect(await sentMail(NW)).toHaveLength(1)
    await fire(NW, 'lead.email', leadEmail({ id: 'z-6', from: 'leads@zumper.com', name: 'Sam Park', email: 'sam@renter.example', fields: FIELDS }), plus(T, 2))
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(2)
    expect(mail[1].body).toMatch(/unit 2A/)
    expect((await rows(`select status from pack_leads where org_id = $1 order by created_at`, [NW.org])).map(r => r.status)).toEqual(['slots_offered', 'duplicate', 'duplicate'])
  })

  it('follows up quiet renters on the same cadence, then stops; an unsubscribe stops at once', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'z-7', name: 'A One', email: 'a1@renter.example', fields: FIELDS }), T)
    await fire(NW, 'lead.email', leadEmail({ id: 'z-8', name: 'B Two', email: 'b2@renter.example', fields: FIELDS }), T)
    await fire(NW, 'mail.received', { from: 'b2@renter.example', subject: 'Re', text: 'Please unsubscribe me', messageId: 'r-3' }, plus(T, 1))
    for (const d of [2, 5, 10, 17]) await sweep(NW, plus(T, 24 * d))
    const mail = (await sentMail(NW)).filter(m => /^Following up/.test(m.subject))
    expect(mail.map(m => m.to)).toEqual(['a1@renter.example', 'a1@renter.example', 'a1@renter.example'])
    expect((await rows(`select email, status from pack_leads where org_id = $1 order by email`, [NW.org])).map(r => r.status)).toEqual(['quiet', 'stopped'])
  })

  it('a business name with steering language is refused by the content check: nothing is sent, the owner is told', async () => {
    await admin(db => db.query(`update pack_settings set settings = settings || '{"senderName":"Safe Area Rentals"}' where org_id = $1`, [NW.org]))
    await fire(NW, 'lead.email', leadEmail({ id: 'z-9', name: 'Jordan Miles', email: 'jordan@renter.example', fields: FIELDS }), T)
    expect(await sentMail(NW)).toHaveLength(0)
    expect((await one<{ status: string; error: string }>(`select status, error from pack_messages where org_id = $1`, [NW.org]))).toBeNull() // rolled back with the act
    const [a] = await activity(NW, 'ls_lead_reply')
    expect(a.status).toBe('blocked')
    expect(a.error).toMatch(/fair-housing check \(safe area\)/)
    expect(owner.some(u => u.severity === 'warning' && u.agentKey === 'ls_lead_reply')).toBe(true)
  })
})

describe.skipIf(!ready)('leasing pack: commission', () => {
  let ids: { co: string; maple: string; birch: string }
  beforeEach(async () => { await resetPacks(NW, 'leasing_agent', { settings: { weeklyReportDay: ((T.getUTCDay() + 6) % 7) + 1 } }); ids = await seedListings() })

  it('commission math is exact to the cent (percent of one month, half-up) or flat', () => {
    expect(commissionAmount({ type: 'percent', value: 50 }, 1950)).toBe(975)
    expect(commissionAmount({ type: 'percent', value: 50 }, 1955.55)).toBe(977.78) // 977.775 rounds up
    expect(commissionAmount({ type: 'percent', value: 33.33 }, 1000)).toBe(333.3)
    expect(commissionAmount({ type: 'percent', value: 100 }, 2345.67)).toBe(2345.67)
    expect(commissionAmount({ type: 'percent', value: 12.5 }, 0.04)).toBe(0.01)
    expect(commissionAmount({ type: 'flat', value: 750 }, 99999)).toBe(750)
    expect(commissionCents({ type: 'percent', value: 0 }, 2000)).toBe(0)
    // a thousand placements add up exactly in cents
    let sum = 0
    for (let i = 0; i < 1000; i++) sum += commissionCents({ type: 'percent', value: 45 }, 1000 + i * 0.37)
    expect(Number.isInteger(sum)).toBe(true)
  })

  it('tracks move-ins, builds each property\'s invoice (tenant, unit, move-in, commission), sends it once to the right address', async () => {
    await admin(async db => {
      await recordPlacement(db, NW.org, { propertyId: ids.maple, tenantName: 'Jordan Miles', unit: '4B', moveInDate: day(1), monthlyRent: 1950 })
      await recordPlacement(db, NW.org, { propertyId: ids.maple, tenantName: 'Sam Park', unit: '2A', moveInDate: day(2), monthlyRent: 1955.55 })
      await recordPlacement(db, NW.org, { propertyId: ids.maple, tenantName: 'Later Tenant', unit: '5C', moveInDate: day(30), monthlyRent: 2000 })
      await recordPlacement(db, NW.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: day(2), monthlyRent: 2100 })
    })
    await sweep(NW, plus(T, 24 * 3))
    await sweep(NW, plus(T, 24 * 3 + 1))
    const inv = await rows<{ number: string; total: string; bill_to: string; status: string; lines: { tenant: string; unit: string; moveIn: string; commission: number }[]; property_id: string }>(`select number, total, bill_to, status, lines, property_id from leasing_invoices where org_id = $1 order by number`, [NW.org])
    expect(inv).toHaveLength(2)
    const maple = inv.find(i => i.property_id === ids.maple)!, birch = inv.find(i => i.property_id === ids.birch)!
    expect(maple).toMatchObject({ total: '1952.78', bill_to: 'ap@harborpg.example', status: 'sent' }) // the managing company's billing address
    expect(maple.lines.map(l => [l.tenant, l.unit, l.moveIn, l.commission])).toEqual([['Jordan Miles', '4B', day(1), 975], ['Sam Park', '2A', day(2), 977.78]])
    expect(birch).toMatchObject({ total: '750.00', bill_to: 'billing@birchlofts.example' })
    const mail = (await sentMail(NW)).filter(m => /leasing commission/.test(m.subject))
    expect(mail).toHaveLength(2)
    expect(mail.find(m => m.to === 'ap@harborpg.example')!.body).toMatch(/Jordan Miles, unit 4B, moved in .*commission|Jordan Miles, unit 4B, moved in/)
    expect(mail.find(m => m.to === 'ap@harborpg.example')!.body).toMatch(/Total due: USD\s1,952\.78/)
    expect((await rows(`select status from leasing_placements where org_id = $1 order by move_in_date, tenant_name`, [NW.org])).map(r => r.status)).toEqual(['invoiced', 'invoiced', 'invoiced', 'pending'])
    expect((await activity(NW, 'ls_commission_invoice')).every(a => a.status === 'done' && a.proof.some(p => /Invoice total equals its move-ins/.test(p.label)))).toBe(true)
  })

  it('a property without any billing address waits for the owner; nothing is half-built', async () => {
    const p = (await admin(db => db.one<{ id: string }>(`insert into leasing_properties (org_id, name, commission_type, commission_value) values ($1,'Nowhere Flats','flat',500) returning id`, [NW.org])))!
    await admin(db => recordPlacement(db, NW.org, { propertyId: p.id, tenantName: 'T', unit: '1', moveInDate: day(1), monthlyRent: 1000 }))
    await sweep(NW, plus(T, 24 * 2))
    expect(await rows(`select id from leasing_invoices where org_id = $1`, [NW.org])).toHaveLength(0)
    expect((await one(`select status, invoice_id from leasing_placements where org_id = $1`, [NW.org]))).toMatchObject({ status: 'moved_in', invoice_id: null })
    expect((await activity(NW, 'ls_commission_invoice'))[0].error).toMatch(/no billing email/)
  })

  it('chases, records a part payment then the rest, marks it paid, and ignores a repeated payment notice', async () => {
    await admin(db => recordPlacement(db, NW.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: day(1), monthlyRent: 2100 }))
    await sweep(NW, plus(T, 24 * 2)) // invoiced, due in 30 days
    const inv = (await one<{ number: string }>(`select number from leasing_invoices where org_id = $1`, [NW.org]))!
    await sweep(NW, plus(T, 24 * 35)) // 3 days late: reminder 1
    await fire(NW, 'quickbooks.payment', { invoiceNumber: inv.number, amount: 300, paymentId: 'p-1', receivedOn: day(36) }, plus(T, 24 * 36))
    await fire(NW, 'quickbooks.payment', { invoiceNumber: inv.number, amount: 300, paymentId: 'p-1', receivedOn: day(36) }, plus(T, 24 * 36 + 1))
    expect((await one(`select status, paid_amount from leasing_invoices where org_id = $1`, [NW.org]))).toMatchObject({ status: 'partial', paid_amount: '300.00' })
    await sweep(NW, plus(T, 24 * 42)) // 10 days late: reminder 2 with the open balance
    const reminders = (await sentMail(NW)).filter(m => m.to === 'billing@birchlofts.example' && !/leasing commission/.test(m.subject))
    expect(reminders).toHaveLength(2)
    expect(reminders[1].body).toMatch(/USD\s450\.00 of USD\s750\.00/)
    await fire(NW, 'quickbooks.payment', { invoiceNumber: inv.number, amount: 450, paymentId: 'p-2', receivedOn: day(43) }, plus(T, 24 * 43))
    expect((await one(`select status, paid_amount from leasing_invoices where org_id = $1`, [NW.org]))).toMatchObject({ status: 'paid', paid_amount: '750.00' })
    expect((await one(`select status from leasing_placements where org_id = $1`, [NW.org]))!.status).toBe('paid')
    await sweep(NW, plus(T, 24 * 60))
    expect((await sentMail(NW)).filter(m => /^Re:|overdue/.test(m.subject))).toHaveLength(2)
  })

  it('an unpaid invoice goes to the owner a week after the last reminder', async () => {
    await admin(db => recordPlacement(db, NW.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: day(1), monthlyRent: 2100 }))
    await sweep(NW, plus(T, 24 * 2))
    for (const d of [35, 42, 52, 55, 60, 61]) await sweep(NW, plus(T, 24 * d))
    expect(owner.filter(u => /unpaid after 3 reminders/.test(u.headline))).toHaveLength(1)
  })

  it('a payment can be undone; the invoice goes back to what the remaining payments say', async () => {
    await admin(db => recordPlacement(db, NW.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: day(1), monthlyRent: 2100 }))
    await sweep(NW, plus(T, 24 * 2))
    const inv = (await one<{ id: string }>(`select id from leasing_invoices where org_id = $1`, [NW.org]))!
    const r = await admin(db => recordPayment(db, NW.org, { invoiceId: inv.id, amount: 750, receivedOn: day(3) }))
    expect(r.invoice.status).toBe('paid')
    expect(await admin(db => undoPayment(db, { paymentId: r.paymentId }))).toMatchObject({ ok: true })
    expect((await one(`select status, paid_amount from leasing_invoices where id = $1`, [inv.id]))).toMatchObject({ status: 'sent', paid_amount: '0.00' })
    expect((await one(`select status from leasing_placements where org_id = $1`, [NW.org]))!.status).toBe('invoiced')
    await expect(admin(db => recordPayment(db, NW.org, { invoiceId: inv.id, amount: 0, receivedOn: day(3) }))).rejects.toThrow(/above zero/)
  })

  it('weekly totals: invoiced, collected and owed are exact, and the weekly email goes out once on its day', async () => {
    await admin(async db => {
      await recordPlacement(db, NW.org, { propertyId: ids.maple, tenantName: 'Jordan Miles', unit: '4B', moveInDate: day(-6), monthlyRent: 1950 })
      await recordPlacement(db, NW.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: day(-6), monthlyRent: 2100 })
    })
    await sweep(NW, plus(T, -24 * 5)) // last week: two invoices (975 + 750)
    const [a, b] = await rows<{ id: string; total: string }>(`select id, total from leasing_invoices where org_id = $1 order by total desc`, [NW.org])
    await admin(async db => {
      await recordPayment(db, NW.org, { invoiceId: a.id, amount: 500, receivedOn: day(-3) })
      await recordPayment(db, NW.org, { invoiceId: b.id, amount: 750, receivedOn: day(-2) })
      await recordPayment(db, NW.org, { invoiceId: a.id, amount: 100, receivedOn: day(0) }) // this week: not counted
    })
    const t = await admin(db => weeklyTotals(db, NW.org, day(-7), day(0)))
    expect(t).toMatchObject({ invoiced: 1725, invoices: 2, collected: 1250, payments: 2, owed: 375 })
    owner.length = 0
    await sweep(NW, T)
    await sweep(NW, plus(T, 2))
    const weekly = owner.filter(u => u.agentKey === 'ls_weekly_report')
    expect(weekly).toHaveLength(1)
    expect(weekly[0].headline).toMatch(/USD\s1,725\.00 invoiced, USD\s1,250\.00 collected, USD\s375\.00 owed/)
    await sweep(NW, plus(T, 24)) // not the report day
    expect(owner.filter(u => u.agentKey === 'ls_weekly_report')).toHaveLength(1)
  })
})
