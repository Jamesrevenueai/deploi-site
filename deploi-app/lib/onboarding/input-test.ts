/**
 * "Test input source": exercises the adapter behind the engagement's input method and records the
 * result as evidence on the input_source_tested item. A mocked adapter (no credentials) records
 * evidence with simulated: true, which never satisfies the testing gate. Only email and SMS
 * methods can be exercised here; CSV, webhook and manual entry are verified by a real import.
 */
import type { Db } from '../db'
import { sendEmail } from '../adapters/email'
import { sendSms } from '../adapters/sms'
import { completeItem } from './checklist'
import { log } from '../log'

export type InputTestResult = { ok: boolean; mocked: boolean; method: string; reference: string | null; error?: string; recorded: boolean }

export async function testInputSource(db: Db, input: { engagementId: string; inputMethod: string | null; actorId: string; actorEmail: string; smsTo?: string | null }): Promise<InputTestResult> {
  const method = input.inputMethod ?? 'manual_entry'
  let r: { ok: boolean; mocked: boolean; ref?: string; error?: string }
  if (method === 'email_inbox') {
    const s = await sendEmail({ to: input.actorEmail, subject: 'Deploi input-source test', text: 'This message tests the email path for an engagement. No client data is included.' })
    r = { ok: s.ok, mocked: s.mocked, ref: s.id, error: s.error }
  } else if (method === 'sms_reply') {
    if (!input.smsTo) return { ok: false, mocked: false, method, reference: null, error: 'no test number', recorded: false }
    const s = await sendSms({ to: input.smsTo, body: 'Deploi input-source test. Reply STOP to opt out.' })
    r = { ok: s.ok, mocked: s.mocked, ref: s.sid, error: s.error }
  } else {
    return { ok: false, mocked: false, method, reference: null, error: `${method} is verified by a real import, not a test send`, recorded: false }
  }
  const evidence = { method: 'adapter_test', adapter: method === 'email_inbox' ? 'email' : 'sms', ok: r.ok, simulated: r.mocked, mocked: r.mocked, reference: r.ref ?? null, at: new Date().toISOString() }
  await completeItem(db, { engagementId: input.engagementId, key: 'input_source_tested', actorId: input.actorId, note: r.mocked ? 'Simulated: the adapter is mocked (no provider credentials). Does not satisfy the gate.' : r.ok ? 'Live test send succeeded.' : `Live test failed: ${r.error ?? 'unknown'}`, evidence })
  log.info('onboarding.input_test', { engagement_id: input.engagementId, ok: r.ok, mocked: r.mocked })
  return { ok: r.ok, mocked: r.mocked, method, reference: r.ref ?? null, error: r.error, recorded: true }
}
