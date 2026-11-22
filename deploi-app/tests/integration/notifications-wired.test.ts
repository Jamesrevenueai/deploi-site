/**
 * Billing notices and operations alerts reach people through the system mailer: held (and recorded) while live
 * sending is off, sent exactly once when it is allowed, and never twice for the same notice.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { RESEND_EMAILS_URL } from '../../lib/email/system'
import { setBillingNotifier, queueNotice, deliverNotices } from '../../lib/billing/notify'
import { systemMailNotifier, setOpsNotifier } from '../../lib/ops/notify'
import { NW } from '../merchant/helpers'

const ready = await prepareDb()
const posted: { to: string[]; subject: string; text: string }[] = []
const ENV = ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS']

describe.skipIf(!ready)('notifications go through the system mailer', () => {
  beforeEach(async () => {
    posted.length = 0
    setEmailFetch(async (url, init) => {
      if (url !== RESEND_EMAILS_URL) throw new Error(`unexpected HTTP call: ${url}`)
      const b = JSON.parse(String(init.body)); posted.push({ to: [].concat(b.to), subject: b.subject, text: b.text })
      return new Response(JSON.stringify({ id: `re_${posted.length}` }), { status: 200 })
    })
    process.env.RESEND_API_KEY = 're_test_key'
    setBillingNotifier(null); setOpsNotifier(null)
    // other billing tests can leave pending notices for this organization; this test delivers only its own
    await admin(db => db.query(`delete from billing_notices where org_id = $1 and (dedupe_key like 'wired:%' or status = 'pending')`, [NW.org]))
  })
  afterEach(async () => {
    setEmailFetch(null)
    for (const k of ENV) delete process.env[k]
    await admin(db => db.query(`delete from system_emails where idempotency_key like 'billing:%' or idempotency_key like 'ops:wired%'`))
  })

  it('a billing notice is held while live sends are off, then sent once when they are allowed', async () => {
    process.env.EMAIL_LIVE_SENDS = 'off'
    const id = await admin(db => queueNotice(db, { orgId: NW.org, kind: 'payment_failed', dedupeKey: `wired:${Date.now()}`, subject: 'Your payment did not go through', body: 'Update your card to keep your agents running.', link: 'https://billing.example/portal' }))
    expect(id).toBeTruthy()
    expect(await deliverNotices({ orgId: NW.org })).toMatchObject({ sent: 0, skipped: 1 })
    expect(posted).toHaveLength(0)
    const held = await admin(db => db.one<{ status: string; subject: string }>(`select status, subject from system_emails where idempotency_key = $1`, [`billing:${id}`]))
    expect(held).toMatchObject({ status: 'held', subject: 'Your payment did not go through' })

    const id2 = await admin(db => queueNotice(db, { orgId: NW.org, kind: 'payment_recovered', dedupeKey: `wired:ok:${Date.now()}`, subject: 'Payment received', body: 'Thank you.', link: null }))
    process.env.EMAIL_LIVE_SENDS = 'allowlist'
    const to = (await admin(db => db.one<{ recipient: string }>(`select recipient from billing_notices where id = $1`, [id2])))!.recipient
    process.env.EMAIL_TEST_RECIPIENTS = to
    expect(await deliverNotices({ orgId: NW.org })).toMatchObject({ sent: 1 })
    expect(posted).toEqual([expect.objectContaining({ to: [to], subject: 'Payment received' })])
    await deliverNotices({ orgId: NW.org })
    expect(posted).toHaveLength(1)
  })

  it('an alert emails each recipient once per alert and event, and reports held mail honestly', async () => {
    process.env.EMAIL_LIVE_SENDS = 'off'
    const n = { audience: 'staff' as const, to: ['ops1@deploi.test', 'ops2@deploi.test'], subject: 'Dead jobs', text: 'Two jobs are dead.', alertId: 'wired-a1', event: 'opened' as const }
    expect(await systemMailNotifier.send(n)).toEqual({ ok: false, reason: '2 of 2 held: live sending is off' })
    process.env.EMAIL_LIVE_SENDS = 'allowlist'; process.env.EMAIL_TEST_RECIPIENTS = '@deploi.test'
    const n2 = { ...n, alertId: 'wired-a2' }
    expect(await systemMailNotifier.send(n2)).toEqual({ ok: true })
    expect(await systemMailNotifier.send(n2)).toEqual({ ok: true })
    expect(posted.map(p => p.to[0]).sort()).toEqual(['ops1@deploi.test', 'ops2@deploi.test'])
  })
})
