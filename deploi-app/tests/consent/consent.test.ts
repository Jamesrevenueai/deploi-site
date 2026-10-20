import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { mockSmsOutbox } from '../../lib/adapters/sms'
import { mockOutbox } from '../../lib/adapters/email'
import '../../workers'
import { runWorker, sendProposedAction } from '../../lib/workers/runtime'
import { hasSmsConsent, NO_SMS_CONSENT } from '../../lib/consent/check'

const ready = await prepareDb()

async function resetCredentialRuns() {
  await admin(db => db.query("delete from proposed_actions where worker = 'credential_tracking' and agency_id = $1", [AGENCY_A]))
}
const held = () => admin(db => db.query<{ id: string; kind: string; status: string; hold_reason: string | null }>(
  "select id, kind, status, hold_reason from proposed_actions where worker = 'credential_tracking' and agency_id = $1 order by kind", [AGENCY_A]))

describe.skipIf(!ready)('item 7: SMS consent', () => {
  beforeAll(async () => {
    await admin(db => db.query('update aides set sms_consent = false, sms_consent_at = null where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query("update agencies set auto_send = '{}'::jsonb where id = $1", [AGENCY_A]))
  })

  it('hasSmsConsent resolves aide / applicant / family refs and defaults to false', async () => {
    const aide = uuidFrom('aide:0')
    expect(await admin(db => hasSmsConsent(db, AGENCY_A, `aide:${aide}`))).toBe(false)
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now() where id = $1', [aide]))
    expect(await admin(db => hasSmsConsent(db, AGENCY_A, `aide:${aide}`))).toBe(true)
    expect(await admin(db => hasSmsConsent(db, AGENCY_A, 'scheduler'))).toBe(false)
    expect(await admin(db => hasSmsConsent(db, AGENCY_A, null))).toBe(false)
    await admin(db => db.query('update aides set sms_consent = false, sms_consent_at = null where id = $1', [aide]))
  })

  it('auto-send ON never texts an unconsented aide; the action is held with a reason; emails still go', async () => {
    await resetCredentialRuns()
    await admin(db => db.query("update agencies set auto_send = '{\"credential_tracking\": true}'::jsonb where id = $1", [AGENCY_A]))
    const smsBefore = mockSmsOutbox.length
    const mailBefore = mockOutbox.length
    const s = await runWorker('credential_tracking', AGENCY_A, { dryRun: false })
    const rows = await held()
    const sms = rows.filter(r => r.kind === 'sms')
    const email = rows.filter(r => r.kind === 'email')
    expect(sms.length).toBeGreaterThan(0)
    expect(mockSmsOutbox.length).toBe(smsBefore)
    expect(sms.every(r => r.status === 'proposed' && r.hold_reason === NO_SMS_CONSENT)).toBe(true)
    expect(email.every(r => r.status === 'sent')).toBe(true)
    expect(mockOutbox.length).toBe(mailBefore + email.length)
    expect(s.sent).toBe(email.length)
    await admin(db => db.query("update agencies set auto_send = '{}'::jsonb where id = $1", [AGENCY_A]))
  })

  it('staff Approve on an unconsented recipient is refused and held', async () => {
    const row = (await held()).find(r => r.kind === 'sms')!
    const smsBefore = mockSmsOutbox.length
    const ok = await admin(db => sendProposedAction(db, row.id, { actorId: uuidFrom('user:hello') }))
    expect(ok).toBe(false)
    expect(mockSmsOutbox.length).toBe(smsBefore)
    const after = await admin(db => db.one<{ status: string; hold_reason: string | null }>('select status, hold_reason from proposed_actions where id = $1', [row.id]))
    expect(after?.status).toBe('proposed')
    expect(after?.hold_reason).toBe(NO_SMS_CONSENT)
  })

  it('after consent is recorded the same action sends and the hold clears', async () => {
    const row = (await held()).find(r => r.kind === 'sms')!
    const ref = await admin(db => db.one<{ to_ref: string }>('select to_ref from proposed_actions where id = $1', [row.id]))
    const aideId = ref!.to_ref.split(':')[1]
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now() where id = $1', [aideId]))
    const smsBefore = mockSmsOutbox.length
    const ok = await admin(db => sendProposedAction(db, row.id, { actorId: uuidFrom('user:hello') }))
    expect(ok).toBe(true)
    expect(mockSmsOutbox.length).toBe(smsBefore + 1)
    const after = await admin(db => db.one<{ status: string; hold_reason: string | null }>('select status, hold_reason from proposed_actions where id = $1', [row.id]))
    expect(after?.status).toBe('sent')
    expect(after?.hold_reason).toBeNull()
    await admin(db => db.query('update aides set sms_consent = false, sms_consent_at = null where id = $1', [aideId]))
  })
})
