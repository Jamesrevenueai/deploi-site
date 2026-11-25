import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { injectPortFault } from '../../lib/packs/synthetic'
import { PACK_AGENTS } from '../../lib/packs/registry'
import { NW, resetPacks, fire, sweep, monday, plus, sentMail, one, rows, activity, leadEmail, getSynth } from './helpers'

const ready = await prepareDb()
const T = monday(2)
const buyer = (id: string, extra: Partial<Parameters<typeof leadEmail>[0]> = {}) => leadEmail({ id, from: 'leads@realtor.com', name: 'Morgan Lee', email: 'morgan@buyer.example', subject: 'Inquiry about 12 Oak St', fields: { 'Lead type': 'Buyer' }, text: 'Is it still available?', ...extra })

describe.skipIf(!ready)('real estate pack', () => {
  beforeEach(async () => { await resetPacks(NW, 'real_estate_agent') })

  it('registers four agents', () => {
    expect(PACK_AGENTS.filter(a => a.pack === 'real_estate').map(a => a.key).sort()).toEqual(['re_crm_update', 're_followup', 're_lead_reply', 're_showing'])
  })

  it('replies to a buyer lead with the standard buyer questions and showing times, and logs it in the CRM', async () => {
    await fire(NW, 'lead.email', buyer('re-1'), T)
    const [m] = await sentMail(NW)
    expect(m.to).toBe('morgan@buyer.example')
    expect(m.body).toMatch(/What price range[\s\S]*pre-approved/)
    expect(m.body.match(/^\d\. /gm)!.length).toBeGreaterThanOrEqual(7) // four questions + three times
    const crm = await getSynth(NW.org, 'crm')
    expect(crm.contacts).toHaveLength(1)
    expect(crm.contacts[0]).toMatchObject({ email: 'morgan@buyer.example', stage: 'new lead' })
    expect(crm.contacts[0].tags).toEqual(expect.arrayContaining(['buyer', 'realtor_com']))
    expect((await activity(NW)).map(a => [a.agent_key, a.status])).toEqual([['re_lead_reply', 'done'], ['re_crm_update', 'done']])
    expect((await one(`select crm_record_id from pack_leads where org_id = $1`, [NW.org]))!.crm_record_id).toBe(crm.contacts[0].id)
  })

  it('a seller lead gets the seller template', async () => {
    await fire(NW, 'lead.email', leadEmail({ id: 're-2', from: 'forms@agent-site.example', name: 'Pat Doe', email: 'pat@seller.example', subject: 'What is my home value?', fields: { 'Lead type': 'Seller' } }), T)
    expect((await sentMail(NW))[0].subject).toMatch(/^Selling your home/)
    expect((await one(`select intent from pack_leads where org_id = $1`, [NW.org]))!.intent).toBe('seller')
  })

  it('a lead created in the CRM is answered the same way', async () => {
    await fire(NW, 'crm.lead.created', { externalId: 'crm-77', email: 'casey@buyer.example', name: 'Casey Fox', intent: 'buyer' }, T)
    expect((await sentMail(NW))[0].to).toBe('casey@buyer.example')
    expect((await one(`select source from pack_leads where org_id = $1`, [NW.org]))!.source).toBe('crm')
  })

  it('books the showing the buyer picks, confirms it, and moves the CRM stage', async () => {
    await fire(NW, 'lead.email', buyer('re-3'), T)
    await fire(NW, 'mail.received', { from: 'morgan@buyer.example', subject: 'Re', text: 'The third one works', messageId: 'r-1' }, plus(T, 1))
    expect((await one(`select kind from pack_appointments where org_id = $1`, [NW.org]))!.kind).toBe('showing')
    expect((await sentMail(NW))[1].subject).toMatch(/^Confirmed: a showing/)
    const c = (await getSynth(NW.org, 'crm')).contacts[0]
    expect(c.stage).toBe('showing booked')
    expect(c.notes).toHaveLength(2)
  })

  it('a reply without a time is logged in the CRM, books nothing; an opt-out sets do-not-contact and stops follow-ups', async () => {
    await fire(NW, 'lead.email', buyer('re-4'), T)
    await fire(NW, 'mail.received', { from: 'morgan@buyer.example', subject: 'Re', text: 'What are the HOA fees?', messageId: 'r-2' }, plus(T, 1))
    expect(await rows(`select id from pack_appointments where org_id = $1`, [NW.org])).toHaveLength(0)
    expect((await getSynth(NW.org, 'crm')).contacts[0].stage).toBe('engaged')
    await fire(NW, 'mail.received', { from: 'morgan@buyer.example', subject: 'Re', text: 'unsubscribe', messageId: 'r-3' }, plus(T, 2))
    expect((await getSynth(NW.org, 'crm')).contacts[0].stage).toBe('do not contact')
    for (const d of [3, 6, 12]) await sweep(NW, plus(T, 24 * d))
    expect(await sentMail(NW)).toHaveLength(1)
  })

  it('a CRM that does not answer leaves the reply sent and the CRM step reported, not silently skipped', async () => {
    await injectPortFault(NW.org, 'crm', { op: 'upsertContact', mode: 'unreachable' })
    await fire(NW, 'lead.email', buyer('re-5'), T)
    expect(await sentMail(NW)).toHaveLength(1)
    const crmStep = (await activity(NW, 're_crm_update'))[0]
    expect(crmStep.status).toBe('failed')
  })

  it('follows up quiet leads, then marks them quiet', async () => {
    await fire(NW, 'lead.email', buyer('re-6'), T)
    for (const d of [2, 5, 10, 17]) await sweep(NW, plus(T, 24 * d))
    expect((await sentMail(NW)).filter(m => /^Following up/.test(m.subject))).toHaveLength(3)
    expect((await one(`select status from pack_leads where org_id = $1`, [NW.org]))!.status).toBe('quiet')
  })
})
