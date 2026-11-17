/** Stripe-Signature verification: t + v1 HMAC-SHA256 over `t.rawBody`, 5-minute tolerance, several v1, constant-time. */
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyStripeSignature, signStripePayload, SIGNATURE_TOLERANCE_SEC } from '../../lib/billing/stripe'

const SECRET = ['whsec', 'unit', 'test', 'only'].join('_')
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', created: 1, livemode: false, data: { object: {} } })
const now = 1_800_000_000
const sig = (t: number, payload = body, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')

describe('Stripe webhook signature', () => {
  it('accepts a valid signature and reports its timestamp', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, now), SECRET, { nowSec: now })).toEqual({ ok: true, timestamp: now })
  })
  it('accepts when any one of several v1 signatures matches (secret rotation) and ignores v0', () => {
    const header = `t=${now},v1=${sig(now, body, 'whsec_old')},v0=${sig(now)},v1=${sig(now)}`
    expect(verifyStripeSignature(body, header, SECRET, { nowSec: now }).ok).toBe(true)
    expect(verifyStripeSignature(body, `t=${now},v0=${sig(now)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'malformed_header' })
  })
  it('rejects a wrong secret, a tampered body, or a re-signed timestamp', () => {
    expect(verifyStripeSignature(body, `t=${now},v1=${sig(now, body, 'whsec_other')}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'no_match' })
    expect(verifyStripeSignature(body + ' ', `t=${now},v1=${sig(now)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'no_match' })
    expect(verifyStripeSignature(body, `t=${now + 1},v1=${sig(now)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'no_match' })
  })
  it('enforces the 5-minute tolerance in both directions', () => {
    expect(SIGNATURE_TOLERANCE_SEC).toBe(300)
    const old = now - 301, fresh = now - 299, future = now + 301
    expect(verifyStripeSignature(body, `t=${old},v1=${sig(old)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'outside_tolerance' })
    expect(verifyStripeSignature(body, `t=${fresh},v1=${sig(fresh)}`, SECRET, { nowSec: now }).ok).toBe(true)
    expect(verifyStripeSignature(body, `t=${future},v1=${sig(future)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'outside_tolerance' })
  })
  it('rejects a missing, malformed or truncated header and a missing secret', () => {
    expect(verifyStripeSignature(body, null, SECRET).ok).toBe(false)
    expect(verifyStripeSignature(body, 'garbage', SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'malformed_header' })
    expect(verifyStripeSignature(body, `t=${now},v1=${sig(now).slice(0, 63)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'malformed_header' })
    expect(verifyStripeSignature(body, `t=abc,v1=${sig(now)}`, SECRET, { nowSec: now })).toEqual({ ok: false, reason: 'malformed_header' })
    expect(verifyStripeSignature(body, `t=${now},v1=${sig(now)}`, '', { nowSec: now })).toEqual({ ok: false, reason: 'no_secret' })
  })
})
