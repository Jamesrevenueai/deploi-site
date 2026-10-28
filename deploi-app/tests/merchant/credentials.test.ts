import './env'
import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret, currentKey } from '../../lib/connectors/credentials'

describe('credential encryption', () => {
  it('round-trips, binds to the connection, detects tampering and supports key rotation', () => {
    const a = encryptSecret('shpat_secret_value', 'conn-1')
    expect(a.ciphertext).not.toContain('shpat_secret_value')
    expect(decryptSecret(a.keyId, a.ciphertext, 'conn-1')).toBe('shpat_secret_value')
    expect(() => decryptSecret(a.keyId, a.ciphertext, 'conn-2')).toThrow()
    const parts = a.ciphertext.split('.'); parts[3] = Buffer.from('tampered').toString('base64')
    expect(() => decryptSecret(a.keyId, parts.join('.'), 'conn-1')).toThrow()
    const prev = { id: process.env.CREDENTIALS_KEY_ID!, key: process.env.CREDENTIALS_ENCRYPTION_KEY! }
    process.env.CREDENTIALS_KEY_ID = 'test-k2'; process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
    process.env.CREDENTIALS_PREVIOUS_KEYS = `${prev.id}:${prev.key}`
    expect(decryptSecret(a.keyId, a.ciphertext, 'conn-1')).toBe('shpat_secret_value')
    expect(encryptSecret('x', 'conn-1').keyId).toBe('test-k2')
    process.env.CREDENTIALS_KEY_ID = prev.id; process.env.CREDENTIALS_ENCRYPTION_KEY = prev.key; delete process.env.CREDENTIALS_PREVIOUS_KEYS
  })
  it('refuses to work without a key', () => {
    const k = process.env.CREDENTIALS_ENCRYPTION_KEY
    delete process.env.CREDENTIALS_ENCRYPTION_KEY
    expect(() => currentKey()).toThrow(/not configured/)
    process.env.CREDENTIALS_ENCRYPTION_KEY = k
  })
})
