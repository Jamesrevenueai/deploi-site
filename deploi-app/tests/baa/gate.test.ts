import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { assertBaaSigned, BAA_MESSAGE, BaaNotSignedError, isBaaSigned } from '../../lib/baa/gate'
import { ingestCsv } from '../../lib/evv/ingest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ready = await prepareDb()
const AGENCY = uuidFrom('agency:baa-test')

async function sign(signed: boolean) {
  await admin(db => db.query('update agencies set baa_signed_at = $2, baa_document_url = $3 where id = $1', [AGENCY, signed ? new Date() : null, signed ? `${AGENCY}/baa-test.pdf` : null]))
}

describe.skipIf(!ready)('BAA gate', () => {
  beforeAll(async () => {
    await admin(db => db.query(
      `insert into agencies (id, name, city, county, state) values ($1, 'BAA Test Agency', 'Columbus', 'Franklin', 'OH')
       on conflict (id) do update set baa_signed_at = null, baa_document_url = null`, [AGENCY]))
  })
  afterAll(async () => {
    await admin(async db => {
      await db.query('delete from applicants where agency_id = $1', [AGENCY])
      await db.query('delete from referrals where agency_id = $1', [AGENCY])
      await db.query('delete from evv_exceptions where agency_id = $1', [AGENCY])
      await db.query('delete from visits where agency_id = $1', [AGENCY])
      await db.query('delete from agencies where id = $1', [AGENCY])
    })
  })

  it('assertBaaSigned throws a 403 error until baa_signed_at is set', async () => {
    await sign(false)
    await expect(admin(db => assertBaaSigned(db, AGENCY))).rejects.toMatchObject({ status: 403, message: BAA_MESSAGE })
    await expect(admin(db => assertBaaSigned(db, AGENCY))).rejects.toBeInstanceOf(BaaNotSignedError)
    await sign(true)
    await expect(admin(db => assertBaaSigned(db, AGENCY))).resolves.toBeUndefined()
    expect(await admin(db => isBaaSigned(db, AGENCY))).toBe(true)
  })

  it('applicant webhook: 403 before, 200 after', async () => {
    const { POST } = await import('../../app/api/webhooks/applicant/route')
    const body = JSON.stringify({ agency_id: AGENCY, first_name: 'Gate', last_name: 'Test', phone: '+16145550999', source: 'webhook' })
    const req = () => new Request('http://localhost/api/webhooks/applicant', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    await sign(false)
    const r1 = await POST(req())
    expect(r1.status).toBe(403)
    expect((await r1.json()).error).toBe(BAA_MESSAGE)
    expect(await admin(db => db.query('select id from applicants where agency_id = $1', [AGENCY]))).toHaveLength(0)
    await sign(true)
    const r2 = await POST(req())
    expect(r2.status).toBe(200)
    expect(await admin(db => db.query('select id from applicants where agency_id = $1', [AGENCY]))).toHaveLength(1)
  })

  it('referral inbox (Resend inbound): 403 before, 200 after', async () => {
    const { POST } = await import('../../app/api/webhooks/resend-inbound/route')
    const evt = JSON.stringify({ type: 'email.received', data: { from: 'Case Manager <cm@example.org>', to: [`referrals+${AGENCY}@example.com`], subject: 'New referral', text: 'Client: Test Person\nCounty: Franklin\nService: T1019' } })
    const req = () => new Request('http://localhost/api/webhooks/resend-inbound', { method: 'POST', headers: { 'content-type': 'application/json' }, body: evt })
    await sign(false)
    const r1 = await POST(req())
    expect(r1.status).toBe(403)
    expect(await admin(db => db.query('select id from referrals where agency_id = $1', [AGENCY]))).toHaveLength(0)
    await sign(true)
    const r2 = await POST(req())
    expect(r2.status).toBe(200)
    expect(await admin(db => db.query('select id from referrals where agency_id = $1', [AGENCY]))).toHaveLength(1)
  })

  it('manual referral form and applicant CSV import (staff actions): gated before, open after', async () => {
    // The server actions redirect through next/navigation; exercise the same gate call they make, as the staff user.
    await sign(false)
    await expect(withUser(SESSIONS.staff, db => assertBaaSigned(db, AGENCY))).rejects.toMatchObject({ status: 403 })
    await sign(true)
    await expect(withUser(SESSIONS.staff, db => assertBaaSigned(db, AGENCY))).resolves.toBeUndefined()
  })

  it('EVV / claim CSV import: gated before, writes visits after', async () => {
    const csv = readFileSync(join(process.cwd(), 'tests/fixtures/generic-evv-sample.csv'), 'utf8')
    const { detectMapping } = await import('../../lib/evv/mappers')
    const { parseCsv } = await import('../../lib/evv/ingest')
    const mapping = detectMapping(parseCsv(csv).headers)
    await sign(false)
    await expect(withUser(SESSIONS.staff, async db => { await assertBaaSigned(db, AGENCY); return ingestCsv(db, AGENCY, csv, mapping, { source: 'generic', state: 'OH' }) })).rejects.toMatchObject({ status: 403 })
    expect(await admin(db => db.query('select id from visits where agency_id = $1', [AGENCY]))).toHaveLength(0)
    await sign(true)
    const counts = await withUser(SESSIONS.staff, async db => { await assertBaaSigned(db, AGENCY); return ingestCsv(db, AGENCY, csv, mapping, { source: 'generic', state: 'OH' }) })
    expect(counts.imported).toBeGreaterThan(0)
  })

  it('assessment traces and leak inputs are NOT gated', async () => {
    await sign(false)
    const aid = uuidFrom('assessment:baa-test')
    await admin(db => db.query(`insert into assessments (id, agency_id, status) values ($1, $2, 'in_progress') on conflict (id) do nothing`, [aid, AGENCY]))
    await withUser(SESSIONS.staff, async db => {
      await db.query(`insert into trace_steps (assessment_id, agency_id, trace, step_key, step_order, occurred_at, who) values ($1, $2, 'referral', 'referral_received', 1, now(), 'tester')
                      on conflict (assessment_id, trace, step_key) do update set who = 'tester'`, [aid, AGENCY])
      await db.query(`update assessments set inputs = '{"avg_monthly_referrals": 5}'::jsonb where id = $1`, [aid])
    })
    const rows = await admin(db => db.query('select id from trace_steps where assessment_id = $1', [aid]))
    expect(rows).toHaveLength(1)
    await admin(db => db.query('delete from assessments where id = $1', [aid]))
  })
})
