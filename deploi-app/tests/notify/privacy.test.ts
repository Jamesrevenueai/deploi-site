/**
 * Owner updates, text/voice messages, crew jobs, crew messages and morning reports can name a shopper (an
 * agent's headline, a job's details): a customer data request exports those rows and an erasure removes the
 * address and ids from them, within the shop's organization only. Crew members are the business's own staff.
 */
import '../merchant/env'
import { describe, it, expect, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { collectCustomerData, redactCustomerData, PRIVACY_COVERAGE, PRIVACY_EXEMPT } from '../../lib/privacy/customer-data'
import { NW, HB } from '../merchant/helpers'
import { cleanNotify } from './helpers'

const ready = await prepareDb()
const SHOPPER = 'pat.shopper@buyer.example'

describe.skipIf(!ready)('privacy of owner and crew updates', () => {
  afterEach(async () => { await cleanNotify([NW.org, HB.org]) })

  it('classifies every new table: shopper-bearing tables covered, staff and preferences exempt with reasons', () => {
    for (const t of ['owner_updates', 'notify_outbox', 'crew_jobs', 'crew_messages', 'morning_reports']) expect(PRIVACY_COVERAGE[t], t).toBeTruthy()
    expect(PRIVACY_EXEMPT.crew_members).toMatch(/personal data of staff/)
    expect(PRIVACY_EXEMPT.notify_preferences).toBeTruthy()
  })

  it('exports and erases the shopper from every new table, and leaves the other organization alone', async () => {
    await admin(async db => {
      for (const org of [NW.org, HB.org]) {
        await db.query(`insert into owner_updates (org_id, dedupe_key, agent_key, agent_name, headline, content, channel, status) values ($1,'p1','a','Agent',$2,$3,'email','held')`, [org, `Refunded ${SHOPPER}`, JSON.stringify({ whatHappened: `Customer ${SHOPPER} was charged twice` })])
        await db.query(`insert into notify_outbox (org_id, audience, to_phone, channel, dedupe_key, body, transcript, status) values ($1,'owner','+15555550100','voice','p1',$2,$2,'simulated')`, [org, `Refund for ${SHOPPER}`])
        await db.query(`insert into crew_jobs (org_id, job_ref, details, last_sent) values ($1,'J-P',$2,$3)`, [org, `Deliver to ${SHOPPER}`, JSON.stringify({ details: `Deliver to ${SHOPPER}` })])
        await db.query(`insert into crew_messages (org_id, channel, dedupe_key, body, status) values ($1,'email','p1',$2,'held')`, [org, `Job: deliver to ${SHOPPER}`])
        await db.query(`insert into morning_reports (org_id, report_date, period_start, facts) values ($1, current_date, now(), $2)`, [org, JSON.stringify({ did: [{ headline: `Refunded ${SHOPPER}` }] })])
      }
    })
    const s = { orgId: NW.org, email: SHOPPER, customerId: null, orderIds: [] }
    const ex = await admin(db => collectCustomerData(db, s, 'northwind.myshopify.com'))
    for (const t of ['owner_updates', 'notify_outbox', 'crew_jobs', 'crew_messages', 'morning_reports']) expect(ex.counts[t], t).toBe(1)
    const out = await admin(db => redactCustomerData(db, s))
    for (const t of ['owner_updates', 'notify_outbox', 'crew_jobs', 'crew_messages', 'morning_reports']) expect(out[t], t).toBe(1)
    for (const [t, org, n] of [['owner_updates', NW.org, 0], ['owner_updates', HB.org, 1], ['notify_outbox', NW.org, 0], ['crew_jobs', NW.org, 0], ['crew_jobs', HB.org, 1], ['crew_messages', NW.org, 0], ['morning_reports', NW.org, 0]] as const) {
      const r = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from ${t} x where org_id = $1 and position($2 in lower(x::text)) > 0`, [org, SHOPPER]))
      expect(r!.n, `${t} ${org === NW.org ? 'A' : 'B'}`).toBe(n)
    }
    expect(await admin(db => redactCustomerData(db, s))).toMatchObject({ owner_updates: 0, crew_jobs: 0 })
  })
})
