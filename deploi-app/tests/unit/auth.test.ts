import { describe, it, expect, afterEach } from 'vitest'
import { encodeDevSession, decodeDevSession, DEV_SESSION_TTL_S } from '../../lib/auth'

describe('dev session cookie', () => {
  const s = { uid: '11111111-1111-5111-8111-111111111111', email: 'a@b.c', role: 'client' as const, agencyId: null }
  const saved = process.env.APP_SECRET
  afterEach(() => { process.env.APP_SECRET = saved })

  it('round-trips', () => { expect(decodeDevSession(encodeDevSession(s))).toEqual(s) })
  it('rejects a tampered payload', () => {
    const v = encodeDevSession(s)
    const [p, sig] = v.split('.')
    const tampered = Buffer.from(JSON.stringify({ ...s, role: 'staff' })).toString('base64url')
    expect(decodeDevSession(`${tampered}.${sig}`)).toBeNull()
    expect(decodeDevSession(`${p}.AAAA`)).toBeNull()
    expect(decodeDevSession(undefined)).toBeNull()
  })
  it('expires after the TTL', () => {
    const t0 = Date.UTC(2026, 9, 1)
    const v = encodeDevSession(s, t0)
    expect(decodeDevSession(v, t0 + (DEV_SESSION_TTL_S - 1) * 1000)).toEqual(s)
    expect(decodeDevSession(v, t0 + DEV_SESSION_TTL_S * 1000)).toBeNull()
  })
  it('rotating APP_SECRET invalidates every existing dev cookie', () => {
    const v = encodeDevSession(s)
    process.env.APP_SECRET = 'a-completely-different-secret-value-0123456789'
    expect(decodeDevSession(v)).toBeNull()
  })
  it('refuses to sign or accept anything with a missing or short APP_SECRET (no built-in default)', () => {
    const v = encodeDevSession(s)
    process.env.APP_SECRET = ''
    expect(decodeDevSession(v)).toBeNull()
    expect(() => encodeDevSession(s)).toThrow(/APP_SECRET/)
    process.env.APP_SECRET = 'short'
    expect(() => encodeDevSession(s)).toThrow(/APP_SECRET/)
  })
  it('rejects a legacy cookie without an expiry, even when correctly signed', async () => {
    const { createHmac } = await import('node:crypto')
    const p = Buffer.from(JSON.stringify(s)).toString('base64url')
    const sig = createHmac('sha256', process.env.APP_SECRET!).update(p).digest('base64url')
    expect(decodeDevSession(`${p}.${sig}`)).toBeNull()
  })
})
