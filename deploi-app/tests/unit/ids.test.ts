import { describe, it, expect } from 'vitest'
import { uuidFrom } from '../../lib/ids'
describe('uuidFrom', () => {
  it('is deterministic and uuid-shaped', () => {
    expect(uuidFrom('a')).toBe(uuidFrom('a'))
    expect(uuidFrom('a')).not.toBe(uuidFrom('b'))
    expect(uuidFrom('agency:buckeye')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
