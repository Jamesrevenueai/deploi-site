import { describe, it, expect } from 'vitest'
import { redact } from '../../lib/log'

describe('PHI-safe logger', () => {
  it('redacts person-identifying keys and keeps ids/counts', () => {
    const out = redact({ client_name: 'Jane', email: 'j@x.com', phone: '614', client_id: 'abc', count: 3, nested: { notes: 'secret', status: 'open' } }) as Record<string, unknown>
    expect(out.client_name).toBe('[redacted]')
    expect(out.email).toBe('[redacted]')
    expect(out.phone).toBe('[redacted]')
    expect(out.client_id).toBe('abc')
    expect(out.count).toBe(3)
    expect((out.nested as Record<string, unknown>).notes).toBe('[redacted]')
    expect((out.nested as Record<string, unknown>).status).toBe('open')
  })
  it('truncates long strings', () => {
    expect((redact('x'.repeat(500)) as string).length).toBeLessThan(210)
  })
})
