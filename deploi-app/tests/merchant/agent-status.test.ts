import { describe, it, expect } from 'vitest'
import { executionWords, proposalWords, EXECUTION_STATUS_WORDS } from '../../components/store/format'

describe('truthful merchant status labels', () => {
  it('maps every execution status to its merchant label', () => {
    expect(executionWords('queued').label).toBe('Queued')
    expect(executionWords('prechecking').label).toBe('Running')
    expect(executionWords('executing').label).toBe('Running')
    expect(executionWords('applied').label).toBe('Unconfirmed (checking)')
    expect(executionWords('unknown').label).toBe('Unconfirmed (checking)')
    expect(executionWords('verified').label).toBe('Verified')
    expect(executionWords('failed').label).toBe('Failed')
    expect(executionWords('verification_failed').label).toBe('Failed')
    expect(executionWords('blocked').label).toBe('Blocked')
    expect(executionWords('stale').label).toBe('Stale (records changed)')
    expect(proposalWords('pending_approval').label).toBe('Awaiting approval')
  })

  it('shows success only for verified', () => {
    const ok = Object.entries(EXECUTION_STATUS_WORDS).filter(([, w]) => w.tone === 'ok').map(([k]) => k)
    expect(ok).toEqual(['verified'])
    expect(executionWords('something_new').tone).not.toBe('ok')
  })
})
