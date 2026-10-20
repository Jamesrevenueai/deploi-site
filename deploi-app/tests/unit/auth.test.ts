import { describe, it, expect } from 'vitest'
import { encodeDevSession, decodeDevSession } from '../../lib/auth'

describe('dev session cookie', () => {
  const s = { uid: '11111111-1111-5111-8111-111111111111', email: 'a@b.c', role: 'client' as const, agencyId: null }
  it('round-trips', () => { expect(decodeDevSession(encodeDevSession(s))).toEqual(s) })
  it('rejects a tampered payload', () => {
    const v = encodeDevSession(s)
    const [p, sig] = v.split('.')
    const tampered = Buffer.from(JSON.stringify({ ...s, role: 'staff' })).toString('base64url')
    expect(decodeDevSession(`${tampered}.${sig}`)).toBeNull()
    expect(decodeDevSession(`${p}.AAAA`)).toBeNull()
    expect(decodeDevSession(undefined)).toBeNull()
  })
})
