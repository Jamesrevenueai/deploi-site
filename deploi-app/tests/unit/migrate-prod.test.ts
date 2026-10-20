import { describe, it, expect } from 'vitest'
import { candidateUrls, hasPlaceholderPassword } from '../../scripts/migrate-prod'

describe('production migration runner', () => {
  const pooler = 'postgresql://postgres.abcdefghijklmnop:s3cret@aws-0-us-east-2.pooler.supabase.com:6543/postgres'
  it('derives session-mode and direct candidates from the pooler URI', () => {
    const c = candidateUrls(pooler)
    expect(c[0].url).toContain(':6543/')
    expect(c[1].url).toContain('aws-0-us-east-2.pooler.supabase.com:5432')
    expect(c[2].url).toContain('postgres:s3cret@db.abcdefghijklmnop.supabase.co:5432')
  })
  it('refuses to run with the password placeholder', () => {
    expect(hasPlaceholderPassword('postgresql://u:[PASSWORD HERE]@h:6543/p')).toBe(true)
    expect(hasPlaceholderPassword('postgresql://u:%5BPASSWORD%20HERE%5D@h:6543/p')).toBe(true)
    expect(hasPlaceholderPassword(pooler)).toBe(false)
  })
})
