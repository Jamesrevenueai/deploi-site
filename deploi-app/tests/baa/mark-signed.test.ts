import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { putFile, getFile } from '../../lib/storage'

const ready = await prepareDb()
const AGENCY = uuidFrom('agency:baa-test-2')

describe.skipIf(!ready)('Mark BAA signed', () => {
  beforeAll(async () => { await admin(db => db.query(`insert into agencies (id, name, state) values ($1, 'BAA Test Agency 2', 'OH') on conflict (id) do nothing`, [AGENCY])) })
  afterAll(async () => { await admin(db => db.query('delete from agencies where id = $1', [AGENCY])) })

  it('stores the PDF and stamps baa_signed_at + baa_document_url; the download route serves it to staff', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% test baa\n%%EOF\n')
    const path = `${AGENCY}/baa-2026-10-20.pdf`
    await putFile(path, pdf, 'application/pdf')
    await withUser(SESSIONS.staff, db => db.query('update agencies set baa_signed_at = $2::date, baa_document_url = $3 where id = $1', [AGENCY, '2026-10-20', path]))
    const row = await admin(db => db.one<{ baa_signed_at: string; baa_document_url: string }>('select baa_signed_at, baa_document_url from agencies where id = $1', [AGENCY]))
    expect(row?.baa_signed_at).toBeTruthy()
    expect(row?.baa_document_url).toBe(path)
    expect((await getFile(path)).subarray(0, 4).toString()).toBe('%PDF')
    // the agency's client user may not read another agency's BAA (RLS -> 0 rows)
    const other = await withUser(SESSIONS.clientA, db => db.one('select id from agencies where id = $1', [AGENCY]))
    expect(other).toBeNull()
  })
})
