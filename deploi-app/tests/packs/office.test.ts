import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { recordQuote, scheduleJob } from '../../lib/packs/home-services'
import { agentsFor, PACK_AGENTS } from '../../lib/packs/registry'
import { setupReceivables, resetReceivables, arAgent, inv, day, invoices } from '../office/receivables-helpers'
import { NW, resetPacks, fire, sweep, plus, sentMail, one, activity, crew } from './helpers'

const ready = await prepareDb()
afterAll(async () => { if (ready) { await resetReceivables(NW, { enable: false }); await resetPacks(NW, null) } })

describe.skipIf(!ready)('general office pack', () => {
  beforeEach(async () => { await resetPacks(NW, 'office', { settings: { reviewUrl: 'https://reviews.example/office' } }) })

  it('registers the office agents; the Shopify app shows only working-for-a-store office features and the commerce pack', () => {
    const office = PACK_AGENTS.filter(a => a.pack === 'office').map(a => a.key)
    expect(office).toEqual(expect.arrayContaining(['office_overdue_invoices', 'office_lead_followup', 'office_inbox_triage', 'office_scheduling', 'office_quote_followup', 'office_review_request', 'office_crew_updates']))
    const shopify = agentsFor('shopify').map(a => a.key)
    expect(shopify).toEqual(expect.arrayContaining(['office_overdue_invoices', 'office_inbox_triage', 'office_crew_updates']))
    expect(shopify.some(k => /^(hs|ls|re|pm)_/.test(k))).toBe(false)
    expect(agentsFor('standalone').length).toBe(PACK_AGENTS.length)
  })

  it('a QuickBooks change runs the Office receivables agent through the loop, verified by its run record', async () => {
    const now = new Date()
    const s = await setupReceivables(NW, [inv('1037', day(now, -21), 1250)])
    const agentId = await arAgent(s, 'draft')
    await fire(NW, 'quickbooks.invoice', { invoiceId: '1037' }, now)
    expect((await invoices(agentId)).map(i => i.qbo_invoice_id)).toEqual(['1037'])
    const [a] = await activity(NW, 'office_overdue_invoices')
    expect(a.status).toBe('done')
    expect(a.proof.some(p => p.label === 'Run record on a fresh read' && p.value === 'completed')).toBe(true)
  })

  it('a sweep runs only Office agents that are due; an organization without active agents does nothing', async () => {
    await resetReceivables(NW)
    await fire(NW, 'quickbooks.invoice', { invoiceId: '1' }, new Date())
    expect(await activity(NW, 'office_overdue_invoices')).toEqual([])
    const now = new Date()
    const s = await setupReceivables(NW, [inv('1037', day(now, -21), 1250)])
    const agentId = await arAgent(s, 'draft')
    await admin(db => db.query(`update office_agents set next_run_at = $2 where id = $1`, [agentId, plus(now, 5).toISOString()]))
    await sweep(NW, now)
    expect(await activity(NW, 'office_overdue_invoices')).toEqual([])
    await sweep(NW, plus(now, 6))
    expect((await activity(NW, 'office_overdue_invoices')).map(x => x.status)).toEqual(['done'])
  })

  it('the home-services payment chaser never sends a second reminder when an Office receivables agent is active', async () => {
    await resetPacks(NW, 'home_services', { trade: 'cleaning' })
    const now = new Date()
    const s = await setupReceivables(NW, [])
    await arAgent(s, 'draft')
    const wo = await admin(db => recordQuote(db, NW.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Deep clean', amount: 300, now: plus(now, -24 * 40) }))
    await fire(NW, 'crew.done', { jobRef: wo.ref }, plus(now, -24 * 40))
    await sweep(NW, now)
    expect((await sentMail(NW)).filter(m => /overdue/.test(m.subject))).toHaveLength(0)
  })

  it('quote follow-ups, crew updates, invoicing and review requests work on office jobs', async () => {
    const T = new Date(Date.UTC(2027, 0, 4, 8))
    const c = (await admin(db => db.one<{ id: string }>(`insert into pack_crew_members (org_id, name, email) values ($1,'Pat Packer','pat@crew.example') returning id`, [NW.org])))!
    const wo = await admin(db => recordQuote(db, NW.org, { pack: 'office', customerName: 'Lee Client', customerEmail: 'lee@client.example', description: 'Office move', amount: 1200, now: T }))
    await sweep(NW, plus(T, 24 * 3))
    expect((await sentMail(NW)).map(m => m.subject)).toEqual([expect.stringContaining(wo.ref)])
    await admin(db => scheduleJob(db, NW.org, wo.id, { crewMemberId: c.id, start: plus(T, 24 * 4) }))
    await sweep(NW, plus(T, 24 * 3 + 1))
    expect(crew.map(m => m.jobRef)).toEqual([wo.ref])
    await fire(NW, 'crew.done', { jobRef: wo.ref }, plus(T, 24 * 4 + 5))
    expect((await one(`select status from pack_work_orders where id = $1`, [wo.id]))!.status).toBe('invoiced')
    expect((await activity(NW)).filter(a => a.status !== 'done')).toEqual([])
  })
})
