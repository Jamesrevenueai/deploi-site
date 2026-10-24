import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { mockSmsOutbox } from '../../lib/adapters/sms'
import '../../workers'
import { approveAction, executeAction, insertProposal } from '../../lib/workers/runtime'
import { recordOptOut } from '../../lib/workers/suppress'
import { hasSmsConsent, NO_SMS_CONSENT } from '../../lib/consent/check'

const ready = await prepareDb()
const STAFF = uuidFrom('user:hello')
const IN_WINDOW = new Date(new Date().toISOString().slice(0, 10) + 'T15:00:00Z')
const AGENCY = { id: AGENCY_A, name: 'Buckeye Home Care' }
const AIDE = uuidFrom('aide:7')
const PHONE = '+16145551007'

const status = (id: string) => admin(db => db.one<{ status: string; suppressed_reason: string | null; hold_reason: string | null }>('select status, suppressed_reason, hold_reason from proposed_actions where id = $1', [id]))

describe.skipIf(!ready)('phase 11: opt-out and consent at execution time', () => {
  beforeAll(async () => {
    await admin(db => db.query("delete from proposed_actions where dedupe_key like 'optout-test:%'"))
    // other suites may have left pending texts to this aide on the shared test database; the count below is about ours
    await admin(db => db.query("delete from proposed_actions where to_ref = $1 and status in ('proposed','approved','queued')", [`aide:${AIDE}`]))
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now(), sms_opt_out_at = null, phone = $2 where id = $1', [AIDE, PHONE]))
  })

  it('STOP sets sms_consent off with an opt-out timestamp and suppresses every pending SMS to that recipient', async () => {
    const ids = await admin(async db => [
      (await insertProposal(db, AGENCY, 'credential_tracking', { kind: 'sms', to_ref: `aide:${AIDE}`, body: 'a', payload: {}, dedupe_key: 'optout-test:1' }))!,
      (await insertProposal(db, AGENCY, 'open_shift_fill', { kind: 'sms', to_ref: `aide:${AIDE}`, body: 'b', payload: {}, dedupe_key: 'optout-test:2' }))!,
      (await insertProposal(db, AGENCY, 'credential_tracking', { kind: 'email', to_ref: 'admin', body: 'c', payload: {}, dedupe_key: 'optout-test:3' }))!,
    ])
    await admin(db => approveAction(db, ids[1], { actorId: STAFF })) // approved-but-unsent counts as pending too
    const r = await admin(db => recordOptOut(db, PHONE))
    expect(r.matched).toBe(1)
    expect(r.suppressed).toBe(2)
    const a = await admin(db => db.one<{ sms_consent: boolean; sms_opt_out_at: Date | null }>('select sms_consent, sms_opt_out_at from aides where id = $1', [AIDE]))
    expect(a?.sms_consent).toBe(false)
    expect(a?.sms_opt_out_at).not.toBeNull()
    expect(await status(ids[0])).toMatchObject({ status: 'suppressed', suppressed_reason: 'opt_out' })
    expect(await status(ids[1])).toMatchObject({ status: 'suppressed', suppressed_reason: 'opt_out' })
    expect((await status(ids[2]))?.status).toBe('proposed') // the email to the admin is untouched
    expect(await admin(db => hasSmsConsent(db, AGENCY_A, `aide:${AIDE}`))).toBe(false)
  })

  it('consent revoked between approval and execution blocks the send (checked immediately before sending)', async () => {
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now(), sms_opt_out_at = null where id = $1', [AIDE]))
    const id = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', { kind: 'sms', to_ref: `aide:${AIDE}`, body: 'd', payload: {}, dedupe_key: 'optout-test:4' })))!
    expect((await admin(db => approveAction(db, id, { actorId: STAFF })))?.status).toBe('approved')
    await admin(db => db.query('update aides set sms_consent = false where id = $1', [AIDE]))
    const before = mockSmsOutbox.length
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(r).toMatchObject({ ok: false, reason: NO_SMS_CONSENT })
    expect(mockSmsOutbox.length).toBe(before)
    expect(await status(id)).toMatchObject({ status: 'proposed', hold_reason: NO_SMS_CONSENT })
    await admin(db => db.query('update aides set sms_consent = false, sms_consent_at = null where id = $1', [AIDE]))
  })
})
