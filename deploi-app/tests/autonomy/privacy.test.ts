/** A shopper named in agent events, agent actions and undo links is exported and erased with the rest (customers/data_request, customers/redact). */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { routeEvent } from '../../lib/events'
import { createUndo } from '../../lib/undo'
import { collectCustomerData, redactCustomerData } from '../../lib/privacy/customer-data'
import { NW, HB } from '../merchant/helpers'
import { cleanW1 } from './helpers'

const ready = await prepareDb()
const EMAIL = 'jo.shopper@buyer.example'

describe.skipIf(!ready)('agent events, loops and undo links in customer privacy requests', () => {
  beforeEach(cleanW1)
  afterAll(cleanW1)

  it('exports and erases them in that organization only', async () => {
    for (const org of [NW.org, HB.org]) {
      await routeEvent({ source: 'shopify', type: 'orders/create', orgId: org, externalId: `p-${org}`, occurredAt: new Date().toISOString(), payload: { id: 555, email: EMAIL, customer: { id: 777, first_name: 'Jo' } } })
      await routeEvent({ source: 'shopify', type: 'customers/update', orgId: org, externalId: `pc-${org}`, occurredAt: new Date().toISOString(), payload: { id: 777, first_name: 'Jo' } })
      await admin(db => db.query(`insert into agent_loops (org_id, agent_key, action_type, problem_key, state, action) values ($1,'w1','send_customer_email',$2,'awaiting_owner',$3)`, [org, `p:${org}`, JSON.stringify({ title: `Email ${EMAIL} about the delay` })]))
      await createUndo({ orgId: org, kind: 'w1.x', payload: { to: EMAIL }, summary: `Undo: email to ${EMAIL}` })
    }
    const subject = { orgId: NW.org, email: EMAIL, customerId: '777', orderIds: ['555'] }
    const x = await admin(db => collectCustomerData(db, subject, NW.domain))
    expect(x.counts).toMatchObject({ agent_events: 2, agent_loops: 1, undo_tokens: 1 })
    const out = await admin(db => redactCustomerData(db, subject))
    expect(out).toMatchObject({ agent_events: 2, agent_loops: 1, undo_tokens: 1 })
    const left = await admin(db => db.one<{ e: number; l: string; u: string; open: number }>(`select (select count(*)::int from agent_events where org_id = $1) as e,
      (select string_agg(action::text, '') from agent_loops where org_id = $1) as l, (select string_agg(summary || payload::text, '') from undo_tokens where org_id = $1 and expires_at > now()) as u,
      (select count(*)::int from agent_loops where org_id = $1 and state = 'awaiting_owner') as open`, [NW.org]))
    expect(left).toEqual({ e: 0, l: expect.not.stringContaining(EMAIL), u: null, open: 0 })
    // Harbor's rows are untouched
    expect((await admin(db => collectCustomerData(db, { ...subject, orgId: HB.org }, 'harbor'))).counts).toMatchObject({ agent_events: 2, agent_loops: 1, undo_tokens: 1 })
  })
})
