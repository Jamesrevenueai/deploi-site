/** SMS. Twilio REST when configured, otherwise a mock that records sends. */
import { env } from '../env'
import { log } from '../log'

export type SmsMessage = { to: string; body: string }
export type SmsResult = { ok: boolean; sid?: string; mocked: boolean; error?: string }
export const mockSmsOutbox: SmsMessage[] = []

export async function sendSms(msg: SmsMessage): Promise<SmsResult> {
  const { sid, token, from } = env.twilio
  if (!sid || !token || !from) {
    mockSmsOutbox.push(msg)
    log.info('sms.mock', { bodyLength: msg.body.length })
    return { ok: true, sid: `mock_${Date.now()}`, mocked: true }
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: msg.to, From: from, Body: msg.body }),
    })
    const d = await res.json()
    if (!res.ok) return { ok: false, mocked: false, error: d.message ?? `HTTP ${res.status}` }
    log.info('sms.sent', {})
    return { ok: true, sid: d.sid, mocked: false }
  } catch (e) {
    log.error('sms.failed', { error: (e as Error).message })
    return { ok: false, mocked: false, error: (e as Error).message }
  }
}
