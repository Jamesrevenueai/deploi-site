import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { twilioSignature, verifyTwilio, verifySvix } from '../../lib/workers/webhooks'

describe('webhook signatures', () => {
  it('twilio', () => {
    const params = { From: '+16145550100', Body: 'YES' }
    const sig = twilioSignature('tok', 'https://app.getdeploi.com/api/webhooks/twilio', params)
    expect(verifyTwilio('tok', 'https://app.getdeploi.com/api/webhooks/twilio', params, sig)).toBe(true)
    expect(verifyTwilio('tok', 'https://app.getdeploi.com/api/webhooks/twilio', params, 'nope')).toBe(false)
  })
  it('svix', () => {
    const secret = 'whsec_' + Buffer.from('supersecret').toString('base64')
    const body = '{"type":"email.received"}'
    const sig = 'v1,' + createHmac('sha256', Buffer.from('supersecret')).update('id1.123.' + body).digest('base64')
    expect(verifySvix(secret, 'id1', '123', sig, body)).toBe(true)
    expect(verifySvix(secret, 'id1', '124', sig, body)).toBe(false)
  })
})
