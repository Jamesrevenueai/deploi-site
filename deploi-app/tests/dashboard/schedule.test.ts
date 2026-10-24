import './env'
import { describe, it, expect } from 'vitest'
import { shouldSendNow } from '../../lib/dashboard/schedule'
import { localDayStart } from '../../lib/dashboard/time'

describe('07:00 agency-local gate', () => {
  it('fires only in the 7 o’clock local hour', () => {
    // 11:30Z in October is 07:30 EDT
    expect(shouldSendNow('America/New_York', new Date('2026-10-20T11:30:00Z'), false)).toBe(true)
    expect(shouldSendNow('America/New_York', new Date('2026-10-20T12:30:00Z'), false)).toBe(false)
    // same instant is 06:30 in Chicago
    expect(shouldSendNow('America/Chicago', new Date('2026-10-20T11:30:00Z'), false)).toBe(false)
    expect(shouldSendNow('America/Chicago', new Date('2026-10-20T12:10:00Z'), false)).toBe(true)
    // EST (after DST ends): 07:00 EST = 12:00Z
    expect(shouldSendNow('America/New_York', new Date('2026-12-01T12:05:00Z'), false)).toBe(true)
  })
  it('never sends twice in a day', () => {
    expect(shouldSendNow('America/New_York', new Date('2026-10-20T11:30:00Z'), true)).toBe(false)
  })
  it('falls back to Eastern for a bad timezone', () => {
    expect(shouldSendNow('Not/AZone', new Date('2026-10-20T11:30:00Z'), false)).toBe(true)
  })
  it('localDayStart is midnight local', () => {
    expect(localDayStart('America/New_York', new Date('2026-10-20T11:30:00Z')).toISOString()).toBe('2026-10-20T04:00:00.000Z')
  })
})
