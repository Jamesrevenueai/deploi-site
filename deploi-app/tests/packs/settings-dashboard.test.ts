import '../merchant/env'
import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { chooseBusinessType, updatePackConfig, packsForBusiness, orgPacks } from '../../lib/packs/settings'
import { packView, packWrite, packsOverview } from '../../lib/packs/dashboard'
import { PACK_AGENTS, PACKS } from '../../lib/packs/registry'
import { staffActor } from '../merchant/helpers'
import { NW, HB, merchantActor, resetPacks, fire, monday, leadEmail, PACK_TABLES } from './helpers'
import { SESSIONS } from '../db/helpers'
import { collectCustomerData, redactCustomerData } from '../../lib/privacy/customer-data'

const ready = await prepareDb()
const T = monday(2)

describe.skipIf(!ready)('business type, settings and the pack pages', () => {
  beforeEach(async () => { await resetPacks(NW, null); await resetPacks(HB, null) })

  it('each business type turns on its packs; every pack agent is registered once with a job, triggers and actions', () => {
    expect(packsForBusiness('home_services').sort()).toEqual(['home_services', 'office'])
    expect(packsForBusiness('leasing_agent').sort()).toEqual(['leasing', 'office'])
    expect(packsForBusiness('real_estate_agent').sort()).toEqual(['office', 'real_estate'])
    expect(packsForBusiness('store').sort()).toEqual(['commerce', 'office'])
    expect(packsForBusiness('office')).toEqual(['office'])
    const keys = PACK_AGENTS.map(a => a.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const a of PACK_AGENTS.filter(x => x.pack !== 'commerce')) {
      expect(a.job.length, a.key).toBeGreaterThan(20)
      expect(a.triggers.length && a.actions.length, a.key).toBeTruthy()
      expect(['working', 'synthetic_only', 'planned']).toContain(a.status)
      if (a.pack !== 'office') expect(a.shopifyReady, a.key).toBe(false)
    }
    for (const k of ['home_services', 'leasing', 'real_estate', 'property_management', 'office'] as const) expect(PACK_AGENTS.some(a => a.pack === k), k).toBe(true)
  })

  it('the setup choice saves the business type and trade; a change of type switches the packs; staff and bad input are refused', async () => {
    const nw = await merchantActor(NW)
    expect(await chooseBusinessType(nw, { businessType: 'home_services', trade: 'hvac' })).toEqual({ businessType: 'home_services', packs: packsForBusiness('home_services') })
    expect(await admin(db => orgPacks(db, NW.org))).toMatchObject({ businessType: 'home_services', trade: 'hvac' })
    await chooseBusinessType(nw, { businessType: 'property_manager' })
    expect((await admin(db => orgPacks(db, NW.org))).packs.sort()).toEqual(['leasing', 'office', 'property_management'])
    await expect(chooseBusinessType(nw, { businessType: 'spaceship' })).rejects.toThrow(/choose a business type/)
    await expect(chooseBusinessType(nw, { businessType: 'home_services', trade: 'plumbing-ish' })).rejects.toThrow(/trade/)
    await expect(chooseBusinessType(await staffActor(), { businessType: 'office' })).rejects.toThrow(/staff/)
  })

  it('settings are validated field by field', async () => {
    const nw = await merchantActor(NW)
    await expect(updatePackConfig(nw, { senderName: 'Acme' })).rejects.toThrow(/business type first/)
    await chooseBusinessType(nw, { businessType: 'leasing_agent' })
    expect(await updatePackConfig(nw, { senderName: 'Acme Locators', applicationUrl: 'https://apply.example/x', leadFollowUpDays: [1, 3], days: [1, 2, 3] })).toMatchObject({ senderName: 'Acme Locators' })
    expect((await admin(db => orgPacks(db, NW.org))).config).toMatchObject({ senderName: 'Acme Locators', leadFollowUpDays: [1, 3], days: [1, 2, 3], visitMinutes: 60 })
    for (const bad of [{ applicationUrl: 'http://insecure.example' }, { dayStart: '25:00' }, { visitMinutes: 3 }, { hack: 1 }, { confirmReminderHours: 5, confirmEscalateHours: 4 }])
      await expect(updatePackConfig(nw, bad as Record<string, unknown>)).rejects.toThrow()
  })

  it('the pack page lists its agents, what each did, its records and settings, for the signed-in organization only', async () => {
    const nw = await merchantActor(NW)
    await chooseBusinessType(nw, { businessType: 'leasing_agent' })
    const p = await packWrite(nw, 'property', { name: 'Maple Court', company: 'Harbor PG', companyEmail: 'ap@harborpg.example', commissionType: 'percent', commissionValue: 50 }) as { id: string }
    await packWrite(nw, 'placement', { propertyId: p.id, tenantName: 'Jordan', unit: '4B', moveInDate: '2026-12-01', monthlyRent: 2000 })
    await fire(NW, 'lead.email', leadEmail({ id: 'dash-1', name: 'Jordan', email: 'jordan@renter.example', fields: { Bedrooms: '2' } }), T)
    const v = await packView(nw, 'leasing')
    expect(v.pack).toMatchObject({ key: 'leasing', on: true })
    expect(v.agents.map(a => a.key)).toEqual(PACK_AGENTS.filter(a => a.pack === 'leasing').map(a => a.key))
    expect(v.agents.find(a => a.key === 'ls_lead_reply')!.done).toBe(1)
    expect(v.activity).toHaveLength(1)
    expect((v.records.placements as { commission_amount: string }[])[0].commission_amount).toBe('1000.00')
    expect((v.records.properties as { bill_to: string }[])[0].bill_to).toBe('ap@harborpg.example')
    const o = await packsOverview(nw)
    expect(o.packs.find(x => x.key === 'leasing')).toMatchObject({ done30d: 1 })
    // Harbor sees none of it
    const hb = await merchantActor(HB)
    const hv = await packView(hb, 'leasing')
    expect(hv.activity).toEqual([])
    expect(hv.records.placements).toEqual([])
    // the packs list links every pack, commerce included: its page lists the commerce agents (work log on Completed Work)
    const cv = await packView(nw, 'commerce')
    expect(cv.agents.length).toBeGreaterThanOrEqual(12)
    expect(cv.agents.every(a => a.pack === 'commerce')).toBe(true)
    await expect(packView(nw, 'nope')).rejects.toThrow(/no such pack/)
    await expect(packWrite(nw, 'placement', { propertyId: '00000000-0000-4000-8000-000000000000', tenantName: 'X', unit: '1', moveInDate: '2026-12-01', monthlyRent: 1 })).rejects.toThrow(/not in this organization/)
    await expect(packWrite(nw, 'vendor', { name: 'V', email: 'v@x.example', trades: [] })).rejects.toThrow(/at least one trade/)
    await expect(packWrite(nw, 'explode', {})).rejects.toThrow(/unknown operation/)
  })

  it('"Add a crew member" on the pack page writes the one crew roster (crew_members), not the deprecated pack_crew_members', async () => {
    const nw = await merchantActor(NW)
    await chooseBusinessType(nw, { businessType: 'home_services', trade: 'roofing' })
    await admin(db => db.query(`delete from crew_members where org_id = $1 and email = 'dash.crew@crew.example'`, [NW.org]))
    const before = (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from pack_crew_members where org_id = $1`, [NW.org])))!.n
    const r = await packWrite(nw, 'crew', { name: 'Dash Crew', email: 'dash.crew@crew.example', phone: '+15550111', role: 'field' }) as { id: string }
    expect(await admin(db => db.one(`select name, role, email, phone, active from crew_members where id = $1 and org_id = $2`, [r.id, NW.org]))).toEqual({ name: 'Dash Crew', role: 'field', email: 'dash.crew@crew.example', phone: '+15550111', active: true })
    expect((await admin(db => db.one<{ n: number }>(`select count(*)::int as n from pack_crew_members where org_id = $1`, [NW.org])))!.n).toBe(before)
    const v = await packView(nw, 'home_services')
    expect((v.records.crew as { id: string; role: string }[]).find(c => c.id === r.id)).toMatchObject({ role: 'field' })
    await expect(packWrite(nw, 'crew', { name: 'No Way', email: '', phone: '' })).rejects.toThrow()
    await admin(db => db.query(`delete from crew_members where id = $1`, [r.id]))
  })

  it('every pack table: one organization never reads another\'s rows, and writes from the app roles are refused', async () => {
    await resetPacks(HB, 'leasing_agent')
    await admin(async db => {
      const p = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name) values ($1,'HB Tower') returning id`, [HB.org]))!
      await db.query(`insert into leasing_companies (org_id, name) values ($1,'HB Co')`, [HB.org])
      await db.query(`insert into leasing_listings (org_id, property_id, unit, monthly_rent) values ($1,$2,'1',1000)`, [HB.org, p.id])
      const pl = (await db.one<{ id: string }>(`insert into leasing_placements (org_id, property_id, tenant_name, unit, monthly_rent) values ($1,$2,'T','1',1000) returning id`, [HB.org, p.id]))!
      const inv = (await db.one<{ id: string }>(`insert into leasing_invoices (org_id, property_id, number) values ($1,$2,'CI-9999') returning id`, [HB.org, p.id]))!
      await db.query(`update leasing_placements set invoice_id = $2 where id = $1`, [pl.id, inv.id])
      await db.query(`insert into leasing_payments (org_id, invoice_id, amount) values ($1,$2,10)`, [HB.org, inv.id])
      const l = (await db.one<{ id: string }>(`insert into pack_leads (org_id, pack, external_id, email) values ($1,'leasing','x-1','t@x.example') returning id`, [HB.org]))!
      await db.query(`insert into pack_messages (org_id, agent_key, to_address, subject, body, status, dedupe_key) values ($1,'ls_lead_reply','t@x.example','s','b','sent','k-1')`, [HB.org])
      await db.query(`insert into pack_appointments (org_id, lead_id, kind, starts_at, ends_at) values ($1,$2,'tour',now(),now() + interval '1 hour')`, [HB.org, l.id])
      await db.query(`insert into pack_crew_members (org_id, name) values ($1,'C')`, [HB.org])
      await db.query(`insert into pack_work_orders (org_id, ref) values ($1,'J-1')`, [HB.org])
      await db.query(`insert into pm_vendors (org_id, name) values ($1,'V')`, [HB.org])
      await db.query(`insert into pm_maintenance_requests (org_id, external_id) values ($1,'m-1')`, [HB.org])
      await db.query(`insert into pack_activity (org_id, pack, agent_key, problem_key, status) values ($1,'leasing','ls_lead_reply','p-1','done')`, [HB.org])
    })
    for (const t of PACK_TABLES) {
      const hbOwn = await withUser(SESSIONS.harbor, db => db.one<{ n: number }>(`select count(*)::int as n from ${t} where org_id = $1`, [HB.org]))
      const nwSees = await withUser(SESSIONS.northwind, db => db.one<{ n: number }>(`select count(*)::int as n from ${t} where org_id = $1`, [HB.org]))
      expect(hbOwn!.n, `${t}: Harbor reads its own`).toBeGreaterThan(0)
      expect(nwSees!.n, `${t}: Northwind reads Harbor's`).toBe(0)
      await expect(withUser(SESSIONS.harbor, db => db.query(`delete from ${t} where org_id = $1`, [HB.org])), `${t}: the app role cannot write`).rejects.toThrow(/permission denied/)
    }
    await expect(withUser(SESSIONS.harbor, db => db.query(`select * from pack_synthetic_state`))).rejects.toThrow(/permission denied/)
    expect(Object.keys(PACKS)).toContain('property_management')
  })

  it('a person\'s data in the pack tables is exported and erased on request (leads, messages, jobs, move-ins, maintenance, activity)', async () => {
    const who = 'erase.me@renters.example'
    await resetPacks(NW, 'property_manager')
    await fire(NW, 'lead.email', leadEmail({ id: 'priv-1', name: 'Erase Me', email: who, fields: { Bedrooms: '2' } }), T)
    await admin(async db => {
      const p = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name) values ($1,'P') returning id`, [NW.org]))!
      await db.query(`insert into leasing_placements (org_id, property_id, tenant_name, tenant_email, unit, monthly_rent) values ($1,$2,'Erase Me',$3,'1',1000)`, [NW.org, p.id, who])
      await db.query(`insert into pack_work_orders (org_id, ref, customer_name, customer_email, address) values ($1,'J-9','Erase Me',$2,'1 Main St')`, [NW.org, who])
      await db.query(`insert into pm_maintenance_requests (org_id, external_id, tenant_name, tenant_email) values ($1,'m-9','Erase Me',$2)`, [NW.org, who])
      await db.query(`insert into pack_activity (org_id, pack, agent_key, problem_key, status, title) values ($1,'leasing','re_crm_update','p-9','done',$2)`, [NW.org, `CRM updated for ${who}`])
    })
    const subject = { orgId: NW.org, email: who, customerId: null, orderIds: [] }
    const data = await admin(db => collectCustomerData(db, subject, 'test'))
    for (const t of ['pack_leads', 'pack_messages', 'pack_work_orders', 'leasing_placements', 'pm_maintenance_requests', 'pack_activity']) expect(data.counts[t], t).toBeGreaterThan(0)
    await admin(db => redactCustomerData(db, subject))
    for (const t of ['pack_leads', 'pack_messages', 'pack_work_orders', 'leasing_placements', 'pm_maintenance_requests', 'pack_activity']) {
      const n = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from ${t} x where x.org_id = $1 and position($2 in lower(x::text)) > 0`, [NW.org, who]))
      expect(n!.n, t).toBe(0)
    }
    const again = await admin(db => collectCustomerData(db, subject, 'test'))
    expect(again.counts.pack_leads).toBe(0)
  })
})
