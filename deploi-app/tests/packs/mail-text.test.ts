/**
 * Replies that arrive through the real Outlook path. The inbox sync (storeProviderMessage) stores the message
 * encrypted in email_inbound and emits mail.received with ids, sender and subject only. The pack reply handlers read
 * the text through lib/email/message-text.ts at handling time; the text never lands in agent_events.
 * Found by scripts/scenario-harness.ts (C09, E07): before, every pack reply reader saw an empty text.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { storeProviderMessage } from '../../lib/email/inbox-sync'
import { readInboundText, withInboundText } from '../../lib/email/message-text'
import { runDueJobs } from '../../lib/jobs'
import { EVENT_JOB } from '../../lib/events'
import '../../lib/events/jobs'
import type { EmailAccountRow } from '../../lib/email/accounts'
import type { ProviderMessage } from '../../lib/email/readers/parse'
import { NW, HB, resetPacks, monday, plus, sentMail, one, activity } from './helpers'

const ready = await prepareDb()
const T = monday(2)
const day = (n: number) => new Date(T.getTime() + n * 864e5).toISOString().slice(0, 10)
let n = 0
const msg = (o: Partial<ProviderMessage> & { from: string; subject: string; text: string }): ProviderMessage => {
  const id = `AAMk-text-${Date.now().toString(36)}-${++n}`
  return { providerMessageId: id, providerThreadId: `conv-${id}`, internetMessageId: `<${id}@mail.example>`, to: ['office@nw.example'], cc: [], inReplyTo: null, references: [], receivedAt: T.toISOString(),
    headers: {}, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [], truncated: false, ...o }
}
async function outlook(m = NW) {
  return (await admin(db => db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1,'microsoft',$2,'active',$3,true,true,false,'test') returning *`,
    [m.org, `office-${Math.random().toString(36).slice(2, 8)}@mailtext.example`, ['Mail.Send', 'Mail.ReadWrite']])))!
}
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runDueJobs({ kinds: [EVENT_JOB], limit: 100 })).ran.length) break }
const clean = () => admin(async db => {
  await db.query(`delete from email_inbound where org_id = any($1::uuid[]) and account_id in (select id from email_accounts where address like '%@mailtext.example')`, [[NW.org, HB.org]])
  await db.query(`delete from email_accounts where address like '%@mailtext.example'`)
  await db.query(`delete from agent_events where org_id = any($1::uuid[]) and source = 'outlook'`, [[NW.org, HB.org]])
  await db.query(`delete from connection_events where org_id = any($1::uuid[]) and source = 'outlook'`, [[NW.org, HB.org]])
})

describe.skipIf(!ready)('pack replies through the real Outlook path (text read from the stored message)', () => {
  beforeEach(clean)
  afterAll(async () => { if (ready) { await clean(); await resetPacks(NW, null) } })

  it('a renter answers the standard questions by Outlook: the answers are read from email_inbound and bring the listings', async () => {
    await resetPacks(NW, 'leasing_agent', { settings: { applicationUrl: 'https://apply.example/general' } })
    await admin(async db => {
      const p = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name, billing_email, commission_type, commission_value) values ($1,'Maple Court','ap@maple.example','percent',50) returning id`, [NW.org]))!
      await db.query(`insert into leasing_listings (org_id, property_id, unit, bedrooms, monthly_rent, available_from, pets_allowed) values ($1,$2,'4B',2,1950,$3,false)`, [NW.org, p.id, day(10)])
    })
    const acc = await outlook()
    // the Zillow lead itself, through the inbox sync
    await storeProviderMessage(acc, msg({ from: 'rentalclientservices@zillowrentals.com', subject: 'New Zillow Rentals lead for 1420 NW Lovejoy St #4B',
      text: `You have a new lead!\n\nName: Maya Thompson\nEmail: maya@renter.example\nPhone: (503) 555-0147\nMove-in date: ${day(20)}\nMessage: Hi!` }), 'test')
    await drain()
    const ask = await sentMail(NW)
    expect(ask).toHaveLength(1)
    expect(ask[0].to).toBe('maya@renter.example')
    expect(ask[0].body).toMatch(/What is your monthly budget for rent\?/)
    // the renter's answers, through the inbox sync: mail.received carries no text
    await storeProviderMessage(acc, msg({ from: 'maya@renter.example', subject: 'Re: Your rental inquiry', text: '1. $2,000\n2. 2\n3. no', receivedAt: plus(T, 2).toISOString() }), 'test')
    const ev = await one<{ payload: Record<string, unknown> }>(`select payload from agent_events where org_id = $1 and type = 'mail.received' and payload->>'from' = 'maya@renter.example'`, [NW.org])
    expect(ev!.payload.text).toBeUndefined()
    expect(JSON.stringify(ev!.payload)).not.toMatch(/\$2,000/)
    await drain()
    const mail = await sentMail(NW)
    expect(mail).toHaveLength(2)
    expect(mail[1].body).toMatch(/Maple Court, unit 4B/)
    expect((await activity(NW, 'ls_qualify'))[0].status).toBe('done')
  })

  it('a tenant reports a problem by Outlook: the request is logged with its category and unit from the stored text', async () => {
    await resetPacks(NW, 'property_manager')
    await admin(db => db.query(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Ace Plumbing','dispatch@aceplumbing.example','{plumbing}')`, [NW.org]))
    const acc = await outlook()
    await storeProviderMessage(acc, msg({ from: 'tenant4b@renters.example', subject: 'Problem in my apartment', text: 'Hi, the kitchen sink in unit 4B is leaking under the cabinet.' }), 'test')
    await drain()
    expect(await one(`select category, unit, status from pm_maintenance_requests where org_id = $1`, [NW.org])).toEqual({ category: 'plumbing', unit: '4B', status: 'dispatched' })
    expect((await sentMail(NW)).map(m => m.to)).toEqual(['tenant4b@renters.example', 'dispatch@aceplumbing.example'])
  })

  it('reads only the organization\'s own accepted messages; quarantined mail is never handed to an agent', async () => {
    const acc = await outlook()
    await storeProviderMessage(acc, msg({ from: 'someone@x.example', subject: 'Hello', text: 'the words' }), 'test')
    const row = (await one<{ id: string }>(`select id from email_inbound where account_id = $1`, [acc.id]))!
    expect(await admin(db => readInboundText(db, NW.org, row.id))).toEqual({ subject: 'Hello', text: 'the words' })
    expect(await admin(db => readInboundText(db, HB.org, row.id))).toBeNull()
    expect(await admin(db => readInboundText(db, NW.org, 'not-an-id'))).toBeNull()
    await admin(db => db.query(`update email_inbound set status = 'quarantined' where id = $1`, [row.id]))
    expect(await admin(db => readInboundText(db, NW.org, row.id))).toBeNull()
    const e = { source: 'outlook' as const, type: 'mail.received', orgId: NW.org, externalId: 'x', occurredAt: T.toISOString(), payload: { inboundId: row.id, from: 'someone@x.example', status: 'quarantined' } }
    expect(await admin(db => withInboundText(db, e))).toBeNull()
    // a payload that already carries its text (the pack contract shape) is left as it is
    const withText = { ...e, payload: { from: 'a@b.example', text: 'given' } }
    expect(await admin(db => withInboundText(db, withText))).toBe(withText)
  })
})
