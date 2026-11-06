import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { classifyMaintenance } from '../../lib/packs/property-management'
import { PACKS } from '../../lib/packs/registry'
import { packsForBusiness } from '../../lib/packs/settings'
import { NW, resetPacks, fire, sweep, monday, plus, sentMail, one, rows, activity, owner, mutateSynth, getSynth, leadEmail } from './helpers'

const ready = await prepareDb()
const T = monday(2)
const tenantMail = (text: string, from = 'tenant4b@renters.example', id = `t-${Math.random()}`) => ({ from, fromName: 'Riley Tenant', subject: 'Kitchen sink leaking', text, messageId: id })
async function vendors() {
  return admin(async db => ({
    plumber: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Ace Plumbing','dispatch@aceplumbing.example','{plumbing}') returning id`, [NW.org]))!.id,
    plumber2: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Best Pipes','jobs@bestpipes.example','{plumbing}') returning id`, [NW.org]))!.id,
    handy: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Handy Co','work@handy.example','{general}') returning id`, [NW.org]))!.id,
  }))
}
const vendorReply = (from: string, text: string) => ({ from, subject: 'Re: Work order', text, messageId: `v-${Math.random()}` })

describe.skipIf(!ready)('property management pack', () => {
  beforeEach(async () => { await resetPacks(NW, 'property_manager') })

  it('a property manager gets maintenance, leasing (the same renter agents) and office', () => {
    expect(packsForBusiness('property_manager').sort()).toEqual(['leasing', 'office', 'property_management'])
    expect(PACKS.leasing.businessTypes).toContain('property_manager')
  })

  it('classifies maintenance mail by rules', () => {
    expect(classifyMaintenance('The kitchen sink is leaking')).toEqual({ category: 'plumbing', emergency: false, isMaintenance: true })
    expect(classifyMaintenance('Water everywhere, a pipe burst!')).toMatchObject({ category: 'plumbing', emergency: true })
    expect(classifyMaintenance('No heat since last night')).toMatchObject({ category: 'hvac', emergency: true })
    expect(classifyMaintenance('When is rent due?').isMaintenance).toBe(false)
  })

  it('logs a tenant email, tells the tenant, dispatches the right vendor, updates the tenant, and closes on the tenant\'s YES', async () => {
    const v = await vendors()
    await fire(NW, 'mail.received', tenantMail('Hi, the kitchen sink in unit 4B is leaking under the cabinet.'), T)
    const req = (await one<{ id: string; category: string; unit: string; status: string; vendor_id: string }>(`select id, category, unit, status, vendor_id from pm_maintenance_requests where org_id = $1`, [NW.org]))!
    expect(req).toMatchObject({ category: 'plumbing', unit: '4B', status: 'dispatched', vendor_id: v.plumber })
    let mail = await sentMail(NW)
    expect(mail.map(m => m.to)).toEqual(['tenant4b@renters.example', 'dispatch@aceplumbing.example'])
    expect(mail[1].body).toMatch(/Issue: plumbing[\s\S]*Reply ACCEPT/)
    await fire(NW, 'mail.received', vendorReply('dispatch@aceplumbing.example', `Accept, we can go ${new Date(T.getTime() + 864e5).toISOString().slice(0, 10)}`), plus(T, 1))
    mail = await sentMail(NW)
    expect(mail[2]).toMatchObject({ to: 'tenant4b@renters.example' })
    expect(mail[2].body).toMatch(/Ace Plumbing will come to fix the plumbing issue on/)
    await fire(NW, 'mail.received', vendorReply('dispatch@aceplumbing.example', 'Fixed, all done.'), plus(T, 26))
    expect((await sentMail(NW))[3].subject).toBe('Is your plumbing issue fixed?')
    await fire(NW, 'mail.received', { from: 'tenant4b@renters.example', subject: 'Re: Is your plumbing issue fixed?', text: 'Yes, all good now. Thanks!', messageId: 'c-1' }, plus(T, 30))
    expect((await one(`select status from pm_maintenance_requests where id = $1`, [req.id]))!.status).toBe('confirmed')
    expect((await activity(NW)).filter(a => a.status !== 'done')).toEqual([])
  })

  it('a vendor who declines is replaced by the next vendor for the trade; when none are left the owner is told', async () => {
    const v = await vendors()
    await fire(NW, 'mail.received', tenantMail('The toilet is clogged and will not flush.'), T)
    await fire(NW, 'mail.received', vendorReply('dispatch@aceplumbing.example', 'Sorry, decline, fully booked'), plus(T, 1))
    expect((await one(`select vendor_id, declined_vendor_ids from pm_maintenance_requests where org_id = $1`, [NW.org]))).toMatchObject({ vendor_id: v.plumber2, declined_vendor_ids: [v.plumber] })
    await fire(NW, 'mail.received', vendorReply('jobs@bestpipes.example', 'Cannot take it, decline'), plus(T, 2))
    expect((await one<{ vendor_id: string }>(`select vendor_id from pm_maintenance_requests where org_id = $1`, [NW.org]))!.vendor_id).toBe(v.handy) // the general vendor
    await fire(NW, 'mail.received', vendorReply('work@handy.example', 'decline'), plus(T, 3))
    expect((await one(`select status from pm_maintenance_requests where org_id = $1`, [NW.org]))!.status).toBe('escalated')
    expect(owner.some(u => u.agentKey === 'pm_vendor_dispatch' && u.severity === 'warning')).toBe(true)
  })

  it('a vendor who never answers is replaced after the wait (sooner for an emergency)', async () => {
    const v = await vendors()
    await fire(NW, 'mail.received', tenantMail('Pipe burst, water everywhere in unit 2!', 'tenant2@renters.example'), T)
    await sweep(NW, plus(T, 1))
    expect((await one<{ vendor_id: string }>(`select vendor_id from pm_maintenance_requests where org_id = $1`, [NW.org]))!.vendor_id).toBe(v.plumber)
    await sweep(NW, plus(T, 2.1)) // half the wait: emergency moves on
    expect((await one<{ vendor_id: string }>(`select vendor_id from pm_maintenance_requests where org_id = $1`, [NW.org]))!.vendor_id).toBe(v.plumber2)
    expect((await sentMail(NW))[1].subject).toMatch(/^EMERGENCY Work order/)
  })

  it('the tenant says NO: the same vendor is sent back', async () => {
    const v = await vendors()
    await fire(NW, 'mail.received', tenantMail('The sink is leaking.'), T)
    await fire(NW, 'mail.received', vendorReply('dispatch@aceplumbing.example', 'fixed'), plus(T, 5))
    await fire(NW, 'mail.received', { from: 'tenant4b@renters.example', subject: 'Re', text: 'No, still leaking.', messageId: 'c-2' }, plus(T, 8))
    const r = (await one<{ status: string; vendor_id: string }>(`select status, vendor_id from pm_maintenance_requests where org_id = $1`, [NW.org]))!
    expect(r).toMatchObject({ status: 'dispatched', vendor_id: v.plumber })
    expect((await sentMail(NW)).at(-1)!.subject).toMatch(/return visit/)
  })

  it('a request from the property system (Buildium) is read fresh, dispatched, and marked completed there after the tenant confirms', async () => {
    await vendors()
    await mutateSynth(NW.org, 'property_system', s => { s.requests.push({ id: 'B-501', property: 'Maple Court', unit: '7D', tenantName: 'Kai Green', tenantEmail: 'kai@renters.example', tenantPhone: '555 0101', description: 'Dishwasher not working', category: 'Appliance', status: 'new', notes: [] }) })
    await admin(db => db.query(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Appliance Pros','fix@appliancepros.example','{appliance}')`, [NW.org]))
    await fire(NW, 'buildium.maintenance.created', { requestId: 'B-501' }, T)
    await fire(NW, 'buildium.maintenance.created', { requestId: 'B-501' }, plus(T, 0.1)) // the same request again: logged once
    expect(await rows(`select id from pm_maintenance_requests where org_id = $1`, [NW.org])).toHaveLength(1)
    expect((await getSynth(NW.org, 'property_system')).requests[0].status).toBe('assigned')
    await fire(NW, 'mail.received', vendorReply('fix@appliancepros.example', 'Done, repaired the pump'), plus(T, 20))
    await fire(NW, 'mail.received', { from: 'kai@renters.example', subject: 'Re', text: 'yes it works now', messageId: 'c-3' }, plus(T, 22))
    expect((await getSynth(NW.org, 'property_system')).requests[0].status).toBe('completed')
    expect((await activity(NW, 'pm_tenant_update')).at(-1)!.proof.map(p => p.value)).toEqual(['confirmed', 'completed'])
  })

  it('a tenant who cannot be reached: the request is still dispatched, the owner is told to call', async () => {
    await vendors()
    await mutateSynth(NW.org, 'property_system', s => { s.requests.push({ id: 'B-502', property: 'Maple Court', unit: '1A', tenantName: 'No Mail', tenantEmail: null, tenantPhone: '555 0102', description: 'Sink leak', category: null, status: 'new', notes: [] }) })
    await fire(NW, 'buildium.maintenance.created', { requestId: 'B-502' }, T)
    const ack = (await activity(NW, 'pm_maintenance_intake'))[0]
    expect(ack.status).toBe('blocked')
    expect(ack.error).toMatch(/call the tenant on 555 0102/)
    expect((await one(`select status from pm_maintenance_requests where org_id = $1`, [NW.org]))!.status).toBe('dispatched')
    // a bounced tenant address is reported as not verified
    await mutateSynth(NW.org, 'mail', s => { s.bounce = ['gone@renters.example'] })
    await fire(NW, 'mail.received', tenantMail('Lock is broken on my door', 'gone@renters.example'), plus(T, 1))
    expect((await activity(NW, 'pm_maintenance_intake')).at(-1)!.status).toBe('not_verified')
  })

  it('a fixed request the tenant never confirms is closed after three days', async () => {
    await vendors()
    await fire(NW, 'mail.received', tenantMail('The sink is leaking.'), T)
    await fire(NW, 'mail.received', vendorReply('dispatch@aceplumbing.example', 'fixed'), plus(T, 5))
    await sweep(NW, plus(T, 24 * 2))
    expect((await one(`select status from pm_maintenance_requests where org_id = $1`, [NW.org]))!.status).toBe('fixed')
    await sweep(NW, plus(T, 24 * 4))
    expect((await one(`select status from pm_maintenance_requests where org_id = $1`, [NW.org]))!.status).toBe('closed')
  })

  it('a renter lead is not mistaken for a maintenance request, and is answered by the leasing agents', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 'pm-l1', name: 'Jo', email: 'jo@renter.example', fields: { Bedrooms: '1' } }), T)
    await fire(NW, 'mail.received', { from: 'jo@renter.example', subject: 'Re', text: 'Is the broken elevator fixed yet?', messageId: 'x-1' }, plus(T, 1))
    expect(await rows(`select id from pm_maintenance_requests where org_id = $1`, [NW.org])).toHaveLength(0)
    expect((await sentMail(NW))[0].subject).toMatch(/rental inquiry/)
  })

  it('reminds tenants whose rent is late, once per due date, from the property system balances', async () => {
    await mutateSynth(NW.org, 'property_system', s => {
      s.rentDue = [
        { tenantId: 't1', tenantName: 'Kai Green', tenantEmail: 'kai@renters.example', property: 'Maple Court', unit: '7D', amountDue: 1450, dueDate: new Date(T.getTime() - 3 * 864e5).toISOString().slice(0, 10), currency: 'USD' },
        { tenantId: 't2', tenantName: 'Paid Up', tenantEmail: 'paid@renters.example', property: 'Maple Court', unit: '1A', amountDue: 0, dueDate: new Date(T.getTime() - 3 * 864e5).toISOString().slice(0, 10), currency: 'USD' },
        { tenantId: 't3', tenantName: 'Not Yet', tenantEmail: 'notyet@renters.example', property: 'Maple Court', unit: '2B', amountDue: 1450, dueDate: new Date(T.getTime() + 3 * 864e5).toISOString().slice(0, 10), currency: 'USD' },
        { tenantId: 't4', tenantName: 'No Email', tenantEmail: null, property: 'Maple Court', unit: '3C', amountDue: 900, dueDate: new Date(T.getTime() - 3 * 864e5).toISOString().slice(0, 10), currency: 'USD' },
      ]
    })
    await sweep(NW, T)
    await sweep(NW, plus(T, 1))
    const mail = (await sentMail(NW)).filter(m => /^Rent reminder/.test(m.subject))
    expect(mail.map(m => m.to)).toEqual(['kai@renters.example'])
    expect(mail[0].body).toMatch(/USD\s1,450\.00/)
    expect((await activity(NW, 'pm_rent_reminder')).map(a => a.status).sort()).toEqual(['blocked', 'done'])
  })
})
