/**
 * Organization deletion (owner only, 7-day cooling-off, cancel, then revoke, cancel billing, delete,
 * keep legal and billing records, final audit outside the organization) and data retention (only expired
 * rows are touched).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { audit } from '../../lib/engine/audit'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB } from '../merchant/helpers'
import { cancelDeletion, deletionStatus, executeDeletion, executeDueDeletions, requestDeletion, KEPT_TABLES, type Revokers } from '../../lib/platform/deletion'
import { retentionDefaults, retentionFor, runRetention, setRetention } from '../../lib/platform/retention'
import { enqueuePlatformWork } from '../../lib/platform/jobs'
import { platformLag } from '../../lib/platform/health'
import { aiComplete } from '../../lib/ai/gateway'

const ready = await prepareDb()
const ORG = uuidFrom('merchant:doomed-test')
const OWNER = uuidFrom('user:doomed:owner'), MEMBER = uuidFrom('user:doomed:member'), ADMIN = uuidFrom('user:doomed:admin')
const actor = (uid: string, email: string): Actor => ({ kind: 'profile', session: { uid, email, role: 'client', agencyId: ORG, orgType: 'merchant' }, orgId: ORG, label: `user:${email}` })
const owner = actor(OWNER, 'owner@doomed.example'), member = actor(MEMBER, 'member@doomed.example'), adminA = actor(ADMIN, 'admin@doomed.example')
const BILLING = ['BILLING_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
const savedEnv = Object.fromEntries(BILLING.map(k => [k, process.env[k]]))
const restoreEnv = () => { for (const k of BILLING) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] } }

async function seedOrg() {
  await admin(async db => {
    await db.query(`delete from org_deletion_requests where org_id = $1`, [ORG])
    // a clean start: the whole organization goes (legal acceptances can only be removed with it), and its audit chain head
    await db.query('delete from agencies where id = $1', [ORG])
    await db.query('delete from engine_audit_chain where chain_key = $1', [ORG])
    await db.query(`delete from auth.users where id = any($1::uuid[])`, [[OWNER, MEMBER, ADMIN]])
    await db.query(`insert into agencies (id, name, state, org_type) values ($1, 'Doomed Goods', '', 'merchant') on conflict (id) do update set name = 'Doomed Goods', deleted_at = null`, [ORG])
    for (const [id, email, role] of [[OWNER, 'owner@doomed.example', 'owner'], [ADMIN, 'admin@doomed.example', 'admin'], [MEMBER, 'member@doomed.example', 'member']]) {
      await db.query('insert into auth.users (id, email) values ($1,$2)', [id, email])
      await db.query(`update profiles set agency_id = $2, org_role = $3 where id = $1`, [id, ORG, role])
    }
    await db.query(`insert into store_connections (id, org_id, platform, external_id, status, is_synthetic) values ($2, $1, 'woocommerce', 'https://doomed.example', 'active', true), ($3, $1, 'shopify', 'doomed-goods.myshopify.com', 'active', true) on conflict (id) do nothing`,
      [ORG, uuidFrom('conn:doomed:woo'), uuidFrom('conn:doomed:shop')])
    const acc = (await db.one<{ id: string }>(`insert into email_accounts (org_id, provider, address, connected_by, status) values ($1, 'synthetic', 'ops@doomed.example', 'test', 'active') returning id`, [ORG]))!.id
    await db.query(`insert into office_connections (org_id, provider, external_account_id, connected_by) values ($1, 'hubspot', 'portal-doomed', 'test')`, [ORG])
    await db.query(`insert into email_messages (org_id, account_id, task_key, dedupe_key, status, from_address, to_addresses, key_id, content_ciphertext, content_hash, internet_message_id)
      values ($1, $2, 'run_report', 'doomed-1', 'accepted', 'ops@doomed.example', '{a@b.example}', 'k1', 'secret-content', repeat('a', 64), '<doomed-1@x>')`, [ORG, acc])
    await db.query(`insert into cases (org_id, suite, kind, source_app, dedupe_key, title, problem) values ($1, 'commerce', 'test_case', 'import', 'doomed-case', 'A case', 'A problem')`, [ORG])
    await db.query(`insert into jobs (kind, org_id, payload, status) values ('test.record', $1, '{}', 'succeeded')`, [ORG])
    await db.query(`insert into ai_usage (org_id, agent_ref, purpose, tier, model, outcome) values ($1, 'engine:x', 'a.b', 'routine', 'm', 'ok')`, [ORG])
    await db.query(`insert into legal_acceptances (org_id, user_id, document_key, document_version, document_sha256, document_status, product, method) values ($1, $2, 'terms', '1', repeat('b', 64), 'published', 'commerce', 'clickwrap')`, [ORG, OWNER])
    await db.query(`insert into billing_customers (org_id, external_id) values ($1, 'cus_doomed') on conflict do nothing`, [ORG])
    await db.query(`insert into billing_subscriptions (org_id, provider, external_id, status, plan) values ($1, 'stripe', 'sub_doomed', 'active', 'starter') on conflict do nothing`, [ORG])
    await audit(db, { orgId: ORG, entityType: 'org', entityId: ORG, event: 'test.history', actor: 'test' })
  })
}
const count = (t: string, col = 'org_id') => admin(db => db.one<{ n: number }>(`select count(*)::int as n from ${t} where ${col} = $1`, [ORG])).then(r => r!.n)

describe.skipIf(!ready)('organization deletion', () => {
  beforeEach(async () => { restoreEnv(); await seedOrg() })
  afterEach(() => restoreEnv())

  it('only an owner may request or cancel; the cooling-off period is 7 days; a request can be cancelled', async () => {
    await expect(requestDeletion(member)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(requestDeletion(adminA)).rejects.toMatchObject({ code: 'forbidden' })
    const now = new Date('2026-11-05T10:00:00Z')
    const r = await requestDeletion(owner, { now })
    expect(r).toMatchObject({ status: 'pending', requested_by: 'user:owner@doomed.example' })
    expect(new Date(r.execute_after).getTime() - now.getTime()).toBe(7 * 864e5)
    expect((await requestDeletion(owner)).id).toBe(r.id) // one open request
    expect((await deletionStatus(member)).request).toMatchObject({ id: r.id, status: 'pending' })
    // nothing happens during the cooling-off period
    expect(await executeDeletion(r.id, { now: new Date(now.getTime() + 6 * 864e5) })).toBeNull()
    expect(await count('cases')).toBe(1)
    await expect(cancelDeletion(member)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await cancelDeletion(owner)).toMatchObject({ status: 'cancelled', cancelled_by: 'user:owner@doomed.example' })
    expect(await executeDueDeletions({ now: new Date(now.getTime() + 30 * 864e5) })).toEqual([])
    await expect(cancelDeletion(owner)).rejects.toMatchObject({ code: 'not_pending' })
    expect(await count('cases')).toBe(1)
  })

  it('after the cooling-off period: tokens revoked (fakes), billing cancelled, data gone, legal and billing records kept, final audit outside the org', async () => {
    const now = new Date()
    const r = await requestDeletion(owner, { now })
    const revoked: string[] = []
    const fakes: Revokers = {
      email: async a => { revoked.push(`email:${a.provider}`); return 'revoked' },
      woocommerce: async c => { revoked.push(`woocommerce:${c.id}`); return 'disconnected' },
      shopify: async c => { revoked.push(`shopify:${c.id}`); return 'not_supported' },
      office: async c => { revoked.push(`office:${c.provider}`); return 'not_supported' },
    }
    Object.assign(process.env, { BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_doomed', STRIPE_WEBHOOK_SECRET: 'whsec_doomed' })
    const stripeCalls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => { stripeCalls.push(`${init.method} ${new URL(url).pathname}`); return new Response(JSON.stringify({ id: 'sub_doomed', status: 'canceled' }), { status: 200 }) }) as unknown as typeof fetch
    // the job queue picks it up once due
    const later = new Date(now.getTime() + 7 * 864e5 + 60e3)
    expect((await enqueuePlatformWork(later)).length).toBe(2)
    const out = await executeDueDeletions({ now: later, revokers: fakes, fetchImpl })
    const mine = out.find(o => o.id === r.id)!
    expect(mine).toMatchObject({ status: 'completed', billing: 'cancelled', accountsDeleted: 3 })
    expect(revoked.sort()).toEqual([`email:synthetic`, 'office:hubspot', `shopify:${uuidFrom('conn:doomed:shop')}`, `woocommerce:${uuidFrom('conn:doomed:woo')}`])
    expect(stripeCalls).toEqual(['DELETE /v1/subscriptions/sub_doomed'])
    // data gone
    for (const t of ['cases', 'email_messages', 'email_accounts', 'store_connections', 'office_connections', 'jobs', 'ai_usage', 'org_controls']) expect(await count(t), t).toBe(0)
    expect(await admin(db => db.one<{ n: number }>(`select count(*)::int as n from profiles where agency_id = $1 or id = any($2::uuid[])`, [ORG, [OWNER, MEMBER, ADMIN]]))).toEqual({ n: 0 })
    // every org-scoped table outside the kept list is empty for this organization
    const tables = await admin(db => db.query<{ table_name: string; column_name: string }>(`select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name in ('org_id','agency_id')`))
    for (const t of tables.filter(t => !(KEPT_TABLES as readonly string[]).includes(t.table_name))) expect(await count(t.table_name, t.column_name), t.table_name).toBe(0)
    // kept: legal acceptance, billing records (subscription now cancelled), the audit trail, a tombstone organization
    expect(await count('legal_acceptances')).toBe(1)
    expect(await admin(db => db.one('select status from billing_subscriptions where org_id = $1', [ORG]))).toEqual({ status: 'canceled' })
    expect(await count('billing_customers')).toBe(1)
    expect(await admin(db => db.one<{ name: string; deleted: boolean }>('select name, deleted_at is not null as deleted from agencies where id = $1', [ORG]))).toEqual({ name: 'Deleted organization', deleted: true })
    const final = await admin(db => db.one<{ org_id: string | null; actor: string }>(`select org_id, actor from engine_audit where event = 'org.deleted' and entity_id = $1`, [ORG]))
    expect(final).toEqual({ org_id: null, actor: 'system:deletion' })
    // the tamper-evident chains still verify (the org's history is kept; the global chain has the final entry)
    expect(await admin(db => db.one('select ok from verify_engine_audit_chain($1)', [ORG]))).toEqual({ ok: true })
    expect(await admin(db => db.one('select ok from verify_engine_audit_chain(null)'))).toEqual({ ok: true })
    // repeating does nothing; the deleted organization gets no model calls
    expect(await executeDueDeletions({ now: later, revokers: fakes, fetchImpl })).toEqual([])
    process.env.AI_PROVIDER = 'fake'
    try { expect(await aiComplete({ orgId: ORG, agentRef: 'x', purpose: 'a.b', tier: 'routine', input: 'x' })).toMatchObject({ ok: false }) } finally { delete process.env.AI_PROVIDER }
    expect(await admin(db => platformLag(db, later))).toMatchObject({ deletion: { overdue: 0 } })
  })

  it('a failed deletion is recorded and retried; the lag is visible to monitoring', async () => {
    const r = await requestDeletion(owner)
    const later = new Date(Date.now() + 8 * 864e5)
    await admin(db => db.query(`update org_deletion_requests set execute_after = now() - interval '1 hour' where id = $1`, [r.id]))
    expect(await admin(db => platformLag(db))).toMatchObject({ deletion: { overdue: 1, oldestOverdueHours: expect.any(Number) } })
    const boom: Partial<Revokers> = { email: async () => { throw new Error('provider down') } }
    // a revoker that throws is recorded as failed, the deletion still completes (tokens are deleted with the data)
    const out = await executeDeletion(r.id, { now: later, revokers: { ...boom, woocommerce: async () => 'disconnected' } })
    expect(out).toMatchObject({ status: 'completed', revoked: { email: { failed: 1 } } })
  })

  afterAll(async () => {
    if (!ready) return
    await admin(async db => {
      await db.query('delete from auth.users where id = any($1::uuid[])', [[OWNER, MEMBER, ADMIN]])
      await db.query('delete from agencies where id = $1', [ORG])
      await db.query('delete from engine_audit_chain where chain_key = $1', [ORG])
    })
  })
})

describe.skipIf(!ready)('data retention', () => {
  const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString()
  async function seed() {
    return admin(async db => {
      await db.query(`delete from email_messages where dedupe_key like 'ret-%'`)
      await db.query(`delete from jobs where kind = 'test.retention'`)
      await db.query(`delete from rate_limits where bucket = 'test_retention'`)
      await db.query(`delete from webhook_receipts where delivery_id like 'ret-%'`)
      await db.query(`update agencies set retention = '{}' where id = any($1::uuid[])`, [[NW.org, HB.org]])
      const acc = (await db.one<{ id: string }>(`insert into email_accounts (org_id, provider, address, connected_by, status) values ($1, 'synthetic', 'ret@northwind.example', 'test', 'disconnected') returning id`, [NW.org]))!.id
      const msg = (key: string, org: string, status: string, at: string) => db.query(`insert into email_messages (org_id, account_id, task_key, dedupe_key, status, from_address, to_addresses, key_id, content_ciphertext, content_hash, internet_message_id, created_at)
        values ($1, $2, 'run_report', $3, $4, 'ret@northwind.example', '{a@b.example}', 'k1', 'body', repeat('a', 64), $3, $5)`, [org, acc, key, status, at])
      await msg('ret-old', NW.org, 'accepted', ago(400))
      await msg('ret-new', NW.org, 'accepted', ago(30))
      await msg('ret-old-waiting', NW.org, 'awaiting_approval', ago(400)) // not finished: kept
      await db.query(`insert into jobs (kind, org_id, payload, status, finished_at) values ('test.retention', $1, '{}', 'succeeded', $2), ('test.retention', $1, '{}', 'succeeded', $3), ('test.retention', null, '{}', 'queued', $2)`, [NW.org, ago(100), ago(10)])
      await db.query(`insert into rate_limits (bucket, key, window_start, hits, expires_at) values ('test_retention', 'old', $1, 1, $1), ('test_retention', 'new', now(), 1, now() + interval '1 hour')`, [ago(3)])
      await db.query(`insert into webhook_receipts (platform, delivery_id, topic, status, received_at) values ('shopify', 'ret-old', 't', 'processed', $1), ('shopify', 'ret-new', 't', 'processed', $2)`, [ago(120), ago(5)])
      return acc
    })
  }
  afterAll(async () => {
    if (!ready) return
    await admin(async db => {
      await db.query(`delete from email_messages where dedupe_key like 'ret-%'`)
      await db.query(`delete from email_accounts where address = 'ret@northwind.example'`)
      await db.query(`delete from jobs where kind = 'test.retention'`)
      await db.query(`update agencies set retention = '{}' where id = any($1::uuid[])`, [[NW.org, HB.org]])
    })
  })

  it('defaults: email bodies 365 days, inbound raw 30, jobs 90, rate limits 1, webhook receipts 90', () => {
    expect(retentionDefaults({})).toEqual({ emailBodies: 365, inboundRaw: 30, jobs: 90, rateLimits: 1, webhookReceipts: 90 })
    expect(retentionDefaults({ RETENTION_JOBS_DAYS: '30', RETENTION_EMAIL_BODIES_DAYS: '0' })).toMatchObject({ jobs: 30, emailBodies: 365 })
  })

  it('purges only expired rows; unfinished messages and recent rows are kept; it is safe to run again', async () => {
    await seed()
    const r = await runRetention()
    expect(r.emailBodiesErased).toBeGreaterThanOrEqual(1)
    const rows = await admin(db => db.query<{ dedupe_key: string; content_ciphertext: string; purged: boolean }>(`select dedupe_key, content_ciphertext, body_purged_at is not null as purged from email_messages where dedupe_key like 'ret-%' order by dedupe_key`))
    expect(rows).toEqual([
      { dedupe_key: 'ret-new', content_ciphertext: 'body', purged: false },
      { dedupe_key: 'ret-old', content_ciphertext: '', purged: true },
      { dedupe_key: 'ret-old-waiting', content_ciphertext: 'body', purged: false },
    ])
    expect(await admin(db => db.query(`select status from jobs where kind = 'test.retention' order by status`))).toEqual([{ status: 'queued' }, { status: 'succeeded' }])
    expect(await admin(db => db.query(`select key from rate_limits where bucket = 'test_retention'`))).toEqual([{ key: 'new' }])
    expect(await admin(db => db.query(`select delivery_id from webhook_receipts where delivery_id like 'ret-%'`))).toEqual([{ delivery_id: 'ret-new' }])
    const again = await runRetention()
    expect(again).toMatchObject({ emailBodiesErased: 0, jobsDeleted: 0, rateLimitsDeleted: 0, webhookReceiptsDeleted: 0 })
    expect(await admin(db => platformLag(db))).toMatchObject({ retention: { status: 'ok', lagHours: expect.any(Number) } })
  })

  it('an organization may adjust its own periods (owners and admins), within bounds; another organization is unaffected', async () => {
    await seed()
    const { merchantActor } = await import('../merchant/helpers')
    const nw = await merchantActor(NW)
    await expect(setRetention(nw, { rateLimits: 5 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(setRetention(nw, { emailBodies: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    const v = await setRetention(nw, { emailBodies: 20 })
    expect(v.periods.find(p => p.key === 'emailBodies')).toMatchObject({ days: 20, adjusted: true })
    expect((await retentionFor(await merchantActor(HB))).periods.find(p => p.key === 'emailBodies')).toMatchObject({ days: 365, adjusted: false })
    await runRetention()
    expect(await admin(db => db.one(`select body_purged_at is not null as purged from email_messages where dedupe_key = 'ret-new'`))).toEqual({ purged: true })
    await setRetention(nw, { emailBodies: null })
  })
})
