/** Clickwrap acceptance: exact-text matching, org vs user scope, re-acceptance, the gate modes, append-only evidence, the API. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from 'pg'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { NW, HB, resetMerchant } from '../merchant/helpers'
import { uuidFrom } from '../../lib/ids'
import { assertAgreementsAccepted, missingAcceptances, recordAcceptance, requiredAgreements, syncLegalDocuments, requireAgreements, loadLegalDocuments } from '../../lib/legal'
import { GET as legalGet, POST as legalPost } from '../../app/api/store/legal/route'
import { POST as agentsPost } from '../../app/api/store/agents/route'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!, KEY = process.env.SHOPIFY_API_KEY!
const bearer = (shop: string, sub = '7') => ({ authorization: `Bearer ${signSessionToken({ dest: `https://${shop}`, sub }, SECRET, KEY)}` })
const U1 = 'user-one', U2 = 'user-two'
const docsFor = () => requiredAgreements('commerce').map(d => ({ key: d.key, version: d.version, sha256: d.sha256 }))
/** Test cleanup only: the append-only trigger is bypassed with the connection owner's replication role. */
async function clear(org: string) {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try { await c.query('begin'); await c.query('set local session_replication_role = replica'); await c.query('delete from legal_acceptances where org_id = $1', [org]); await c.query('commit') } finally { await c.end() }
}

describe.skipIf(!ready)('legal acceptance', () => {
  beforeEach(async () => { await clear(NW.org); await clear(HB.org) })
  afterEach(() => { delete process.env.LEGAL_GATE; delete process.env.LEGAL_DOCS_DIR; loadLegalDocuments({ fresh: true }) })

  it('records the exact texts, as draft; org documents count for every user, user documents only for the acceptor', async () => {
    expect((await admin(db => missingAcceptances(db, NW.org, U1))).length).toBe(5)
    const out = await admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: docsFor(), ip: '203.0.113.9', userAgent: 'vitest' }, 'draft'))
    expect(out.every(o => o.status === 'draft')).toBe(true)
    expect(await admin(db => missingAcceptances(db, NW.org, U1))).toEqual([])
    // a second person in the same organization still accepts the privacy notice and the AUP personally
    expect((await admin(db => missingAcceptances(db, NW.org, U2))).map(d => d.key).sort()).toEqual(['aup', 'privacy'])
    const row = await admin(db => db.one<Record<string, unknown>>(`select * from legal_acceptances where org_id = $1 and document_key = 'terms'`, [NW.org]))
    expect(row).toMatchObject({ user_id: U1, method: 'clickwrap', document_status: 'draft', ip: '203.0.113.9', user_agent: 'vitest', product: 'commerce' })
    const registry = await admin(db => db.query<{ status: string }>(`select status from legal_documents`))
    expect(registry.length).toBeGreaterThan(0)
    expect(registry.every(r => r.status === 'draft')).toBe(true)
  })

  it('refuses a stale or unknown text', async () => {
    const d = docsFor()
    await expect(admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: [{ ...d[0], sha256: '0'.repeat(64) }] }, 'draft'))).rejects.toMatchObject({ code: 'document_changed' })
    await expect(admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: [{ key: 'made_up', version: '1', sha256: '0'.repeat(64) }] }, 'draft'))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a changed document requires re-acceptance', async () => {
    await admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: docsFor() }, 'draft'))
    const dir = mkdtempSync(join(tmpdir(), 'legal-'))
    cpSync(join(process.cwd(), 'docs', 'legal'), dir, { recursive: true })
    writeFileSync(join(dir, 'TERMS-OF-SERVICE.md'), readFileSync(join(dir, 'TERMS-OF-SERVICE.md'), 'utf8').replace('| Version | 0.1.0-draft |', '| Version | 0.2.0-draft |'))
    process.env.LEGAL_DOCS_DIR = dir
    expect((await admin(db => missingAcceptances(db, NW.org, U1))).map(d => d.key)).toEqual(['terms'])
    await expect(admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'draft'))).rejects.toMatchObject({ status: 428, code: 'agreements_required' })
  })

  it('off is a no-op; draft needs acceptance; enforce also needs the text published', async () => {
    await admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'off'))
    await expect(admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'draft'))).rejects.toMatchObject({ code: 'agreements_required' })
    await admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: docsFor() }, 'draft'))
    await admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'draft'))
    await expect(admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'enforce'))).rejects.toThrow(/not published/)
    await expect(admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: docsFor() }, 'enforce'))).rejects.toMatchObject({ code: 'not_published' })
    // simulate counsel sign-off for this test only, then undo it
    const ids = docsFor()
    try {
      await admin(async db => {
        await syncLegalDocuments(db)
        for (const d of ids) await db.query(`update legal_documents set status = 'published', published_at = now() where key = $1 and version = $2 and sha256 = $3`, [d.key, d.version, d.sha256])
      })
      // a draft-era acceptance of the same exact text still matches; a fresh user needs to accept the published text
      await admin(db => assertAgreementsAccepted(db, NW.org, U1, 'commerce', 'enforce'))
      const out = await admin(db => recordAcceptance(db, { orgId: NW.org, userId: U2, product: 'commerce', documents: ids.filter(d => ['aup', 'privacy'].includes(d.key)) }, 'enforce'))
      expect(out.every(o => o.status === 'published')).toBe(true)
    } finally {
      await admin(db => db.query(`update legal_documents set status = 'draft', published_at = null`))
    }
  })

  it('acceptances are append-only, isolated by organization and unwritable from a user session', async () => {
    await admin(db => recordAcceptance(db, { orgId: NW.org, userId: U1, product: 'commerce', documents: docsFor() }, 'draft'))
    await expect(admin(db => db.query(`update legal_acceptances set ip = 'x' where org_id = $1`, [NW.org]))).rejects.toThrow(/append-only/)
    await expect(admin(db => db.query(`delete from legal_acceptances where org_id = $1`, [NW.org]))).rejects.toThrow(/append-only/)
    await expect(admin(db => db.query(`truncate legal_acceptances`))).rejects.toThrow(/append-only/)
    expect((await withUser(SESSIONS.harbor, db => db.query('select id from legal_acceptances'))).length).toBe(0)
    expect((await withUser(SESSIONS.northwind, db => db.query('select id from legal_acceptances'))).length).toBe(5)
    await expect(withUser(SESSIONS.northwind, db => db.query(`insert into legal_acceptances (org_id, user_id, document_key, document_version, document_sha256, document_status) values ($1,'x','terms','1',$2,'draft')`, [NW.org, 'a'.repeat(64)]))).rejects.toThrow()
    await expect(withUser(SESSIONS.northwind, db => db.query(`update legal_documents set status = 'published', published_at = now()`))).rejects.toThrow()
  })

  it('deleting an organization still removes its acceptances (cascade)', async () => {
    const org = uuidFrom(`legal-cascade:${Date.now()}`)
    await admin(db => db.query(`insert into agencies (id, name, org_type) values ($1, 'Cascade Co', 'merchant')`, [org]))
    await admin(db => recordAcceptance(db, { orgId: org, userId: U1, product: 'commerce', documents: docsFor() }, 'draft'))
    await admin(db => db.query('delete from agencies where id = $1', [org]))
    expect((await admin(db => db.query('select id from legal_acceptances where org_id = $1', [org]))).length).toBe(0)
  })

  it('API: GET lists the texts, POST needs the box ticked, and the gate blocks agent creation until accepted', async () => {
    await resetMerchant(NW)
    process.env.LEGAL_GATE = 'draft'
    const g = await (await legalGet(new Request('http://localhost/api/store/legal', { headers: bearer(NW.domain) }))).json()
    expect(g).toMatchObject({ ok: true, mode: 'draft', product: 'commerce' })
    expect(g.documents).toHaveLength(5)
    expect(g.documents.every((d: { draft: boolean; content: string }) => d.draft && d.content.includes('DRAFT'))).toBe(true)
    const body = { name: 'Gate test', taskText: 'x', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: [], flagInStockVariants: true } }, schedule: { kind: 'manual' }, approvalMode: 'draft' } }
    const blocked = await agentsPost(new Request('http://localhost/api/store/agents', { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect(blocked.status).toBe(428)
    expect((await blocked.json()).error).toBe('agreements_required')
    const docs = g.documents.map((d: { key: string; version: string; sha256: string }) => ({ key: d.key, version: d.version, sha256: d.sha256 }))
    const unticked = await legalPost(new Request('http://localhost/api/store/legal', { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json', 'user-agent': 'vitest-ua' }, body: JSON.stringify({ documents: docs }) }))
    expect(unticked.status).toBe(400)
    const ok = await legalPost(new Request('http://localhost/api/store/legal', { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json', 'user-agent': 'vitest-ua', 'x-forwarded-for': '198.51.100.4' }, body: JSON.stringify({ agreed: true, documents: docs }) }))
    expect(ok.status).toBe(200)
    const row = await admin(db => db.one<{ user_id: string; ip: string; user_agent: string }>(`select user_id, ip, user_agent from legal_acceptances where org_id = $1 limit 1`, [NW.org]))
    expect(row).toEqual({ user_id: `shopify:${NW.domain}:7`, ip: '198.51.100.4', user_agent: 'vitest-ua' })
    const created = await agentsPost(new Request('http://localhost/api/store/agents', { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect(created.status).toBe(200)
    // parsing a sentence grants nothing and is never gated
    await clear(NW.org)
    const parse = await agentsPost(new Request('http://localhost/api/store/agents', { method: 'POST', headers: { ...bearer(NW.domain), 'content-type': 'application/json' }, body: JSON.stringify({ op: 'parse', text: 'stop overselling' }) }))
    expect(parse.status).toBe(200)
  })

  it('requireAgreements does nothing while LEGAL_GATE is off (the default)', async () => {
    await requireAgreements({ kind: 'shopify_user', orgId: NW.org, shop: NW.domain, userId: '7', label: 'x' }, 'commerce')
  })
})
