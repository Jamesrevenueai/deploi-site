/** Free-slot computation: business hours in the customer's zone (DST-correct), buffers, notice, horizon, working days. */
import { describe, it, expect } from 'vitest'
import { allFreeSlots, proposeSlots, type SlotRules } from '../../lib/office/slots'
import { quietUntil } from '../../lib/office/actions'

const rules = (r: Partial<SlotRules> = {}): SlotRules => ({ timezone: 'UTC', days: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', durationMin: 30, bufferMin: 15, minNoticeHours: 1, horizonDays: 7, ...r })

describe('meeting slots', () => {
  it('follows local business hours across the end of British Summer Time', () => {
    // Friday 23 October 2026, 07:00 UTC (08:00 BST). Clocks go back on Sunday 25 October.
    const s = allFreeSlots([], rules({ timezone: 'Europe/London' }), new Date('2026-10-23T07:00:00Z'))
    const friday = s.filter(x => x.start.startsWith('2026-10-23'))
    const monday = s.filter(x => x.start.startsWith('2026-10-26'))
    expect(friday[0].start).toBe('2026-10-23T08:00:00.000Z') // 09:00 BST
    expect(friday.at(-1)!.end).toBe('2026-10-23T16:00:00.000Z') // 17:00 BST
    expect(monday[0].start).toBe('2026-10-26T09:00:00.000Z') // 09:00 GMT
    expect(monday[0].label).toBe('Monday 26 October, 09:00 (Europe/London)')
    expect(s.some(x => x.start.startsWith('2026-10-24') || x.start.startsWith('2026-10-25'))).toBe(false)
  })

  it('follows the start of daylight saving time in New York', () => {
    const s = allFreeSlots([], rules({ timezone: 'America/New_York' }), new Date('2027-03-12T05:00:00Z'))
    expect(s.find(x => x.start.startsWith('2027-03-12'))!.start).toBe('2027-03-12T14:00:00.000Z') // 09:00 EST
    expect(s.find(x => x.start.startsWith('2027-03-15'))!.start).toBe('2027-03-15T13:00:00.000Z') // 09:00 EDT
  })

  it('keeps the buffer around busy times and fits the meeting inside business hours', () => {
    const now = new Date('2026-11-09T06:00:00Z') // Monday
    const s = allFreeSlots([{ start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' }], rules({ horizonDays: 1 }), now).filter(x => x.start.startsWith('2026-11-09'))
    const starts = s.map(x => x.start.slice(11, 16))
    expect(starts.slice(0, 2)).toEqual(['09:00', '11:30'])
    expect(starts).not.toContain('09:30')
    expect(starts).not.toContain('11:00')
    expect(starts.at(-1)).toBe('16:30')
  })

  it('respects minimum notice, the horizon and the local weekday (not the UTC one)', () => {
    // Friday 20:00 UTC is already Saturday morning in Tokyo: no slots until Monday there
    const s = allFreeSlots([], rules({ timezone: 'Asia/Tokyo', minNoticeHours: 12, horizonDays: 4 }), new Date('2026-11-06T20:00:00Z'))
    expect(s[0].start).toBe('2026-11-09T00:00:00.000Z') // Monday 09:00 JST
    expect(s.every(x => new Date(x.start).getTime() <= new Date('2026-11-06T20:00:00Z').getTime() + 4 * 864e5)).toBe(true)
    const soon = allFreeSlots([], rules({ minNoticeHours: 12, horizonDays: 2 }), new Date('2026-11-09T08:00:00Z'))
    expect(soon[0].start).toBe('2026-11-10T09:00:00.000Z')
  })

  it('proposes three slots on different days first', () => {
    const p = proposeSlots([], rules(), new Date('2026-11-09T06:00:00Z'))
    expect(p).toHaveLength(3)
    expect(new Set(p.map(x => x.start.slice(0, 10))).size).toBe(3)
    expect(p.map(x => x.start)).toEqual([...p.map(x => x.start)].sort())
    expect(proposeSlots([{ start: '2026-11-09T00:00:00Z', end: '2026-11-30T00:00:00Z' }], rules(), new Date('2026-11-09T06:00:00Z'))).toEqual([])
  })

  it('quiet hours: emails wait until the local end of quiet hours', () => {
    const q = { start: '19:00', end: '08:00' }
    expect(quietUntil(q, 'UTC', new Date('2026-11-09T22:00:00Z'))!.toISOString()).toBe('2026-11-10T08:00:00.000Z')
    expect(quietUntil(q, 'UTC', new Date('2026-11-09T07:00:00Z'))!.toISOString()).toBe('2026-11-09T08:00:00.000Z')
    expect(quietUntil(q, 'UTC', new Date('2026-11-09T12:00:00Z'))).toBeNull()
    expect(quietUntil(q, 'America/New_York', new Date('2026-11-10T01:00:00Z'))!.toISOString()).toBe('2026-11-10T13:00:00.000Z') // 20:00 EST -> 08:00 EST
    expect(quietUntil(null, 'UTC', new Date())).toBeNull()
  })
})
