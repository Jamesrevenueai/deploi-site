/**
 * Shopify customer privacy webhooks tell the truth (F-07): a data request exports everything Deploi holds for
 * the customer in that shop's organization (stored encrypted, merchant-only download); an erasure deletes or
 * anonymizes it, records what was done, and is idempotent; shop/redact also erases the newer tables. Every
 * table with a personal-looking column is covered or explicitly exempt, and HMAC is still required.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { withOwner } from '../security/pg'
import { admin } from '../../lib/db'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { startConnect, completeConnect } from '../../lib/email/accounts'
import { syntheticCode, SYNTH_SEND } from '../../lib/email/adapters/synthetic'
import { encryptSecret } from '../../lib/connectors/credentials'
import { suppressedAmong } from '../../lib/email/suppression'
import { addNote, openCase } from '../../lib/cases'
import { downloadExport, privacyView } from '../../lib/privacy/exports'
import { PRIVACY_COVERAGE, PRIVACY_EXEMPT, PERSONAL_COLUMN } from '../../lib/privacy/customer-data'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB, merchantActor, staffActor, resetMerchant } from '../merchant/helpers'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const SHOPPER = 'Jo.Shopper+vip@Buyer.example'
const LOWER = SHOPPER.toLowerCase()
const CUSTOMER_ID = 7071
const ORDER_ID = 450789469

function webhook(topic: string, shop: string, body: unknown, id = `wh-${Math.random().toString(36).slice(2)}`, sign = true) {
  const raw = JSON.stringify(body)
  return new Request('http://localhost/api/shopify/webhooks', { method: 'POST', body: raw, headers: {
    'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': id, 'content-type': 'application/json',
    ...(sign ? { 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64') } : {}) } })
}
const send = async (topic: string, shop: string, body: unknown, id?: string) => (await handleShopifyWebhook(webhook(topic, shop, body, id), () => undefined)).status
const payload = (shop: string, extra: Record<string, unknown> = {}) => ({ shop_id: 1, shop_domain: shop, customer: { id: CUSTOMER_ID, email: SHOPPER, phone: null }, ...extra })
const request = (id: string) => admin(db => db.one<{ id: string; status: string; result: Record<string, unknown>; subject_hash: string }>('select id, status, result, subject_hash from shopify_compliance_requests where webhook_id = $1', [id]))

async function mailbox(actor: Actor, address: string) {
  const { url } = await startConnect(actor, { provider: 'synthetic' })
  return (await completeConnect(actor, { state: new URL(url, 'http://x').searchParams.get('state')!, code: syntheticCode(address, [SYNTH_SEND]), error: null })).account
}

/** The shopper in every table that can hold them, for one organization. */
async function seed(m: typeof NW, accountId: string) {
  return admin(async db => {
    const org = m.org
    const msg = await db.one<{ id: string }>(`insert into email_messages (org_id, account_id, task_key, dedupe_key, status, from_address, to_addresses, key_id, content_ciphertext, content_hash, internet_message_id)
      values ($1,$2,'human_reply',$3,'accepted','agent@shop.example',$4,'pending','pending',$5,$6) returning id`, [org, accountId, `p-${org}-${Date.now()}`, [SHOPPER], 'a'.repeat(64), `<${org}.${Date.now()}@test>`])
    const enc = encryptSecret(JSON.stringify({ subject: 'Your order', text: 'Hello Jo, your order ships today.' }), `email-message:${msg!.id}`)
    await db.query('update email_messages set key_id = $2, content_ciphertext = $3 where id = $1', [msg!.id, enc.keyId, enc.ciphertext])
    const inb = await db.one<{ id: string }>(`insert into email_inbound (org_id, account_id, provider_email_id, from_address, classification, status, key_id, content_ciphertext, received_at)
      values ($1,$2,$3,$4,'other','accepted','pending','pending',now()) returning id`, [org, accountId, `prov-${org}-${Date.now()}`, SHOPPER])
    const e2 = encryptSecret(JSON.stringify({ subject: 'Where is my order?', text: 'It has not arrived.' }), `email-inbound:${inb!.id}`)
    await db.query('update email_inbound set key_id = $2, content_ciphertext = $3 where id = $1', [inb!.id, e2.keyId, e2.ciphertext])
    await db.query(`insert into email_suppressions (org_id, address, reason, created_by) values ($1,$2,'unsubscribed','test') on conflict do nothing`, [org, LOWER])
    const agent = await db.one<{ id: string }>(`insert into office_agents (org_id, kind, name, created_by) values ($1,'lead_followup','Lead follow-up','test') returning id`, [org])
    const lead = await db.one<{ id: string }>(`insert into office_leads (org_id, agent_id, hubspot_contact_id, email, first_name, company) values ($1,$2,$3,$4,'Jo','Buyer Ltd') returning id`, [org, agent!.id, `hs-${Date.now()}`, SHOPPER])
    await db.query(`insert into office_meetings (org_id, agent_id, lead_id, contact_email) values ($1,$2,$3,$4)`, [org, agent!.id, lead!.id, LOWER])
    const qconn = await db.one<{ id: string }>(`insert into office_connections (org_id, provider, external_account_id, connected_by) values ($1,'quickbooks',$2,'test') returning id`, [org, `realm-${org.slice(0, 8)}-${Date.now()}`])
    await db.query(`insert into office_invoices (org_id, agent_id, connection_id, realm_id, qbo_invoice_id, customer_name, bill_email, total_amt, balance) values ($1,$2,$3,'r1','1001','Jo Shopper',$4,120.00,120.00)`, [org, agent!.id, qconn!.id, SHOPPER])
    await db.query(`insert into office_actions (org_id, agent_id, kind, purpose, idempotency_key, status, payload, payload_hash) values ($1,$2,'send_email','follow up',$3,'awaiting_approval',$4,$5)`,
      [org, agent!.id, `idem-${Date.now()}`, JSON.stringify({ to: SHOPPER, subject: 'Following up', body: 'Hi Jo' }), 'b'.repeat(64)])
    await db.query(`insert into library_actions (org_id, agent_key, action_type, title, summary, evidence, payload, mode, status) values ($1,'order_tracker','draft_customer_update','Delay update for #1001',$2,$3,$4,'draft','draft')`,
      [org, `A note to Jo (${SHOPPER}) about #1001.`, JSON.stringify({ orderId: `gid://shopify/Order/${ORDER_ID}`, orderName: '#1001' }), JSON.stringify({ to: SHOPPER, subject: 'Your order #1001', body: 'Hi Jo', dedupeKey: `o-${org}:update` })])
    await db.query(`insert into library_chat_messages (org_id, agent_key, role, text) values ($1,'customer_care','merchant',$2)`, [org, `Please reply to ${SHOPPER} about the refund`])
    const c = await openCase(db, { orgId: org, suite: 'commerce', kind: 'library_action', sourceApp: 'shopify', dedupeKey: `privacy-test:${org}:${Date.now()}`, title: `Reply to ${SHOPPER}`, problem: `${SHOPPER} asked about order gid://shopify/Order/${ORDER_ID}`,
      evidence: [{ label: `Message from ${SHOPPER}`, source: 'deploi_email', observedAt: new Date().toISOString() }], records: [{ type: 'email_inbound', id: inb!.id, label: SHOPPER }], verification: { criteria: 'answered' }, actor: 'test' })
    await addNote(db, c.case.id, `Waiting for ${SHOPPER} to confirm`, 'test')
    return { caseId: c.case.id, leadId: lead!.id }
  })
}

/** Every row of a covered table in this organization that still names the shopper (whole row as text). */
async function stillNamed(org: string) {
  const out: Record<string, number> = {}
  for (const t of Object.keys(PRIVACY_COVERAGE)) {
    const r = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from ${t} x where x.org_id = $1 and (position($2 in lower(x::text)) > 0 or position($3 in lower(x::text)) > 0)`, [org, LOWER, `gid://shopify/order/${ORDER_ID}`]))
    if (r!.n) out[t] = r!.n
  }
  return out
}

describe.skipIf(!ready)('every table that can hold a shopper is covered (catalog-driven)', () => {
  it('a table with an email, address, customer, recipient, phone or contact column is covered or exempt with a reason', async () => {
    const rows = await withOwner(c => c.query<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE' order by 1, 2`))
    const personal = [...new Set(rows.rows.filter(r => PERSONAL_COLUMN.test(r.column_name)).map(r => r.table_name))]
    const uncovered = personal.filter(t => !PRIVACY_COVERAGE[t] && !PRIVACY_EXEMPT[t])
    expect(uncovered, 'add each table to PRIVACY_COVERAGE (lib/privacy/customer-data.ts) with its export and erase steps, or to PRIVACY_EXEMPT with the reason it never holds a shopper').toEqual([])
    const tables = new Set(rows.rows.map(r => r.table_name))
    expect([...Object.keys(PRIVACY_COVERAGE), ...Object.keys(PRIVACY_EXEMPT)].filter(t => !tables.has(t))).toEqual([])
    expect(Object.keys(PRIVACY_COVERAGE).filter(t => PRIVACY_EXEMPT[t])).toEqual([])
    for (const [t, why] of Object.entries(PRIVACY_EXEMPT)) expect(why.length, t).toBeGreaterThan(15)
  })
})

describe.skipIf(!ready)('customers/data_request and customers/redact', () => {
  beforeEach(async () => {
    await resetMerchant(NW); await resetMerchant(HB)
    await admin(async db => {
      for (const org of [NW.org, HB.org]) {
        for (const t of ['privacy_exports', 'cases', 'library_actions', 'library_chat_messages', 'email_suppressions', 'email_inbound']) await db.query(`delete from ${t} where org_id = $1`, [org])
        await db.query(`delete from office_agents where org_id = $1`, [org])
        await db.query(`delete from office_connections where org_id = $1 and provider = 'quickbooks'`, [org])
      }
    })
  })

  it('exports everything held for the customer in that shop\'s organization only, encrypted, for the merchant to download', async () => {
    const nw = await merchantActor(NW)
    await seed(NW, (await mailbox(nw, 'agent@northwind-goods.example')).id)
    await seed(HB, (await mailbox(await merchantActor(HB), 'agent@harbor-supply.example')).id)
    const id = `wh-dr-${Date.now()}`
    expect(await send('customers/data_request', NW.domain, payload(NW.domain, { orders_requested: [ORDER_ID], data_request: { id: 9 } }), id)).toBe(200)
    const req = (await request(id))!
    expect(req.status).toBe('completed')
    expect(req.result).toMatchObject({ customer_data_held: true, export_id: expect.any(String), fulfilled: expect.stringMatching(/download/) })
    // per table: every covered table that held the shopper is in the export
    const tables = req.result.tables as Record<string, number>
    for (const t of ['email_messages', 'email_inbound', 'email_suppressions', 'office_leads', 'office_meetings', 'office_invoices', 'office_actions', 'library_actions', 'library_chat_messages', 'cases', 'case_events'])
      expect(tables[t], t).toBeGreaterThan(0)
    expect(tables.engine_audit).toBe(0) // audit entries hold ids, never the address
    // the request record and the stored row never hold the address in clear
    expect(JSON.stringify(req)).not.toMatch(/buyer\.example/i)
    const stored = await admin(db => db.one<Record<string, unknown>>('select * from privacy_exports where id = $1', [req.result.export_id]))
    expect(JSON.stringify(stored)).not.toMatch(/buyer\.example|Jo Shopper|ships today/i)
    expect(stored).toMatchObject({ org_id: NW.org, subject_hash: req.subject_hash })

    // the merchant downloads it: decrypted mail content, Northwind's rows only
    const file = await downloadExport(nw, String(req.result.export_id))
    const data = JSON.parse(file.json) as { subject: { email: string }; tables: Record<string, Record<string, unknown>[]> }
    expect(data.subject.email).toBe(LOWER)
    expect(data.tables.email_messages[0].content).toEqual({ subject: 'Your order', text: 'Hello Jo, your order ships today.' })
    expect(data.tables.email_inbound[0].content).toEqual({ subject: 'Where is my order?', text: 'It has not arrived.' })
    expect(data.tables.office_invoices[0]).toMatchObject({ customer_name: 'Jo Shopper', total_amt: '120.00' })
    expect(JSON.stringify(data)).not.toContain(HB.org)
    const view = await privacyView(nw)
    expect(view.exports[0]).toMatchObject({ id: req.result.export_id, downloads: 1, downloadedBy: nw.label })
    expect(view.requests.map(r => r.topic)).toContain('customers/data_request')
    expect(JSON.stringify(view)).not.toMatch(/buyer\.example/i)

    // cross-organization and staff are refused
    await expect(downloadExport(await merchantActor(HB), String(req.result.export_id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(downloadExport(await staffActor(), String(req.result.export_id))).rejects.toMatchObject({ code: 'forbidden' })
    expect((await privacyView(await merchantActor(HB))).exports).toEqual([])
  })

  it('erases the customer: mail deleted, the rest anonymized, opt-out kept as a hash; recorded per table; idempotent; another organization untouched', async () => {
    const nw = await merchantActor(NW)
    const acc = await mailbox(nw, 'agent@northwind-goods.example')
    const s = await seed(NW, acc.id)
    await seed(HB, (await mailbox(await merchantActor(HB), 'agent@harbor-supply.example')).id)
    const hbBefore = await stillNamed(HB.org)
    // an export made earlier holds the same data: it goes with the erasure
    await send('customers/data_request', NW.domain, payload(NW.domain), `wh-dr0-${Date.now()}`)
    expect((await privacyView(nw)).exports).toHaveLength(1)
    expect(Object.keys(await stillNamed(NW.org)).length).toBeGreaterThan(8)

    const id = `wh-rd-${Date.now()}`
    expect(await send('customers/redact', NW.domain, payload(NW.domain, { orders_to_redact: [ORDER_ID] }), id)).toBe(200)
    expect(await send('customers/redact', NW.domain, payload(NW.domain, { orders_to_redact: [ORDER_ID] }), id)).toBe(200) // duplicate delivery
    const req = (await request(id))!
    expect(req.status).toBe('completed')
    expect(req.result.tables).toMatchObject({ email_messages: 1, email_inbound: 1, email_suppressions: 1, office_leads: 1, office_meetings: 1, office_invoices: 1, office_actions: 1, library_actions: 1, library_chat_messages: 1, cases: 1, case_events: 2, privacy_exports: 1, engine_audit_retained: 0 })
    expect(req.result).toMatchObject({ inbound_deleted: 1, sent_deleted: 1 })

    // nothing in Northwind names the shopper any more; Harbor keeps all of its rows
    expect(await stillNamed(NW.org)).toEqual({})
    expect(await stillNamed(HB.org)).toEqual(hbBefore)
    // what the business must keep is kept, anonymized
    const inv = await admin(db => db.one<Record<string, unknown>>('select customer_name, bill_email, total_amt from office_invoices where org_id = $1', [NW.org]))
    expect(inv).toEqual({ customer_name: null, bill_email: null, total_amt: '120.00' })
    expect(await admin(db => db.one('select status, first_name, stop_reason from office_leads where id = $1', [s.leadId]))).toEqual({ status: 'stopped', first_name: null, stop_reason: "customer data erased at the shop's request" })
    expect(await admin(db => db.one(`select status from office_actions where org_id = $1`, [NW.org]))).toEqual({ status: 'cancelled' })
    expect(await admin(db => db.one(`select status from library_actions where org_id = $1`, [NW.org]))).toEqual({ status: 'expired' })
    // the opt-out still holds: Deploi will not write to that address again
    expect(await admin(db => suppressedAmong(db, NW.org, [SHOPPER]))).toEqual([LOWER])
    // the case keeps its shape and history, with the address erased
    const ev = await admin(db => db.query<{ type: string; summary: string }>('select type, summary from case_events where case_id = $1 order by id', [s.caseId]))
    expect(ev.map(e => e.type)).toEqual(['opened', 'note'])
    expect(ev[1].summary).toBe('Waiting for [erased] to confirm')
    // outside a redaction, case history is still append-only
    await expect(admin(db => db.query(`update case_events set summary = 'x' where case_id = $1`, [s.caseId]))).rejects.toThrow(/append-only/)

    // a new request for the same customer finds nothing more to change
    const again = `wh-rd2-${Date.now()}`
    await send('customers/redact', NW.domain, payload(NW.domain), again)
    const r2 = (await request(again))!
    expect(Object.entries(r2.result.tables as Record<string, number>).filter(([, n]) => n > 0)).toEqual([])
    // and a data request now holds nothing (the opt-out hash is the one thing kept)
    const dr = `wh-dr-after-${Date.now()}`
    await send('customers/data_request', NW.domain, payload(NW.domain), dr)
    const after = (await request(dr))!.result.tables as Record<string, number>
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([['email_suppressions', 1]])
  })

  it('a request matched only by customer and order ids (no email) still finds the records that carry them', async () => {
    const nw = await merchantActor(NW)
    await seed(NW, (await mailbox(nw, 'agent@northwind-goods.example')).id)
    const id = `wh-ids-${Date.now()}`
    await send('customers/data_request', NW.domain, { shop_domain: NW.domain, customer: { id: CUSTOMER_ID }, orders_requested: [ORDER_ID] }, id)
    const t = (await request(id))!.result.tables as Record<string, number>
    expect(t).toMatchObject({ library_actions: 1, cases: 1, email_messages: 0 })
  })

  it('HMAC is still required: unsigned or forged privacy webhooks are refused with 401 and change nothing', async () => {
    const nw = await merchantActor(NW)
    await seed(NW, (await mailbox(nw, 'agent@northwind-goods.example')).id)
    const before = await stillNamed(NW.org)
    for (const t of ['customers/data_request', 'customers/redact', 'shop/redact']) {
      expect((await handleShopifyWebhook(webhook(t, NW.domain, payload(NW.domain), undefined, false), () => undefined)).status).toBe(401)
      const forged = webhook(t, NW.domain, payload(NW.domain))
      const raw = JSON.stringify(payload(HB.domain))
      expect((await handleShopifyWebhook(new Request(forged.url, { method: 'POST', body: raw, headers: forged.headers }), () => undefined)).status).toBe(401)
    }
    expect(await stillNamed(NW.org)).toEqual(before)
    expect((await privacyView(nw)).exports).toEqual([])
  })
})

describe.skipIf(!ready)('shop/redact covers the newer tables', () => {
  it('cases, purchase orders, discovery, AI usage and exports of an erased shop are gone; an organization with another store keeps its other data', async () => {
    const shop = `privacy-redact-${Date.now()}.myshopify.com`
    const r = await ensureInstalled(shop, 'id-token', { exchange: async () => ({ accessToken: 'shpat_p', scope: ['read_products'], expiresIn: 3600, refreshToken: null, refreshTokenExpiresIn: null }), info: async () => ({ name: 'Privacy (synthetic)', timezone: 'UTC' }) })
    await admin(async db => {
      const run = await db.one<{ id: string }>(`insert into discovery_runs (org_id, trigger, created_by) values ($1,'test','test') returning id`, [r.orgId])
      await db.query(`insert into business_profiles (org_id, run_id, profile) values ($1,$2,'{}')`, [r.orgId, run!.id])
      const c = await openCase(db, { orgId: r.orgId, suite: 'commerce', kind: 'shopify_oversell_policy', sourceApp: 'shopify', dedupeKey: `store:${r.connectionId}:x`, title: 'Oversell', problem: 'p', verification: { criteria: 'c', rule: { connectionId: r.connectionId } }, actor: 'test' })
      await db.query(`insert into ai_usage (org_id, agent_ref, case_id, purpose, tier, model, outcome) values ($1,'a',$2,'test','routine','test-model','ok')`, [r.orgId, c.case.id])
      await db.query(`insert into purchase_orders (org_id, connection_id, po_number, supplier_email, ordered_at) values ($1,$2,'PO-1','sup@plier.example',current_date)`, [r.orgId, r.connectionId])
    })
    const count = (t: string) => admin(db => db.one<{ n: number }>(`select count(*)::int as n from ${t} where org_id = $1`, [r.orgId])).then(x => x!.n)
    for (const t of ['cases', 'case_events', 'purchase_orders', 'discovery_runs', 'business_profiles', 'ai_usage']) expect(await count(t), t).toBeGreaterThan(0)
    await send('app/uninstalled', shop, { id: 3 })
    const id = `wh-shop-${Date.now()}`
    await send('shop/redact', shop, { shop_domain: shop }, id)
    expect((await request(id))!.result).toMatchObject({ shop_data_erased: true, organization_erased: true })
    for (const t of ['cases', 'case_events', 'purchase_orders', 'discovery_runs', 'business_profiles', 'ai_usage', 'privacy_exports']) expect(await count(t), t).toBe(0)

    // an organization with two stores: only the erased store's work goes
    const shopA = `privacy-a-${Date.now()}.myshopify.com`
    const a = await ensureInstalled(shopA, 'id-token', { exchange: async () => ({ accessToken: 'shpat_a', scope: ['read_products'], expiresIn: 3600, refreshToken: null, refreshTokenExpiresIn: null }), info: async () => ({ name: 'A (synthetic)', timezone: 'UTC' }) })
    const other = await admin(db => db.one<{ id: string }>(`insert into store_connections (org_id, platform, external_id, display_name, status, scopes) values ($1,'woocommerce',$2,'Other store','active','{}') returning id`, [a.orgId, `https://other-${Date.now()}.example`]))
    await admin(async db => {
      await openCase(db, { orgId: a.orgId, suite: 'commerce', kind: 'shopify_oversell_policy', sourceApp: 'shopify', dedupeKey: `store:${a.connectionId}:y`, title: 'Gone with the shop', problem: 'p', verification: { criteria: 'c' }, actor: 'test' })
      await openCase(db, { orgId: a.orgId, suite: 'commerce', kind: 'woo_backorders', sourceApp: 'woocommerce', dedupeKey: `store:${other!.id}:z`, title: 'Kept', problem: 'p', verification: { criteria: 'c' }, actor: 'test' })
      await db.query(`insert into purchase_orders (org_id, connection_id, po_number, supplier_email, ordered_at) values ($1,$2,'PO-A','sup@plier.example',current_date),($1,$3,'PO-B','sup@plier.example',current_date)`, [a.orgId, a.connectionId, other!.id])
    })
    await send('app/uninstalled', shopA, { id: 4 })
    const id2 = `wh-shop2-${Date.now()}`
    await send('shop/redact', shopA, { shop_domain: shopA }, id2)
    expect((await request(id2))!.result).toMatchObject({ shop_data_erased: true, organization_erased: false })
    expect((await admin(db => db.query<{ title: string }>('select title from cases where org_id = $1', [a.orgId]))).map(c => c.title)).toEqual(['Kept'])
    expect((await admin(db => db.query<{ po_number: string }>('select po_number from purchase_orders where org_id = $1', [a.orgId]))).map(p => p.po_number)).toEqual(['PO-B'])
    await admin(async db => { await db.query('delete from store_connections where id = $1', [other!.id]); await db.query('update profiles set agency_id = null where agency_id = $1', [a.orgId]); await db.query('delete from agencies where id = $1', [a.orgId]) })
  })
})
