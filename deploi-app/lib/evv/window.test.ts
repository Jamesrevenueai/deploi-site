import { describe, it, expect } from 'vitest'
import { windowDays, windowCloses, daysLeft, windowTone, windowLabel } from './window'

const table = { OH: 60, IN: 30, PA: 90 }
describe('correction window', () => {
  it('uses the state table with Ohio as the default', () => {
    expect(windowDays('OH', table)).toBe(60)
    expect(windowDays('in', table)).toBe(30)
    expect(windowDays('PA', table)).toBe(90)
    expect(windowDays('XX', table)).toBe(60)
    expect(windowDays(null, table)).toBe(60)
    expect(windowDays('OH')).toBe(60) // env default
  })
  it('computes the close date and days left', () => {
    const visit = new Date('2026-10-01T12:00:00Z')
    expect(windowCloses(visit, 'OH', table).toISOString()).toBe('2026-11-30T12:00:00.000Z')
    expect(daysLeft(windowCloses(visit, 'OH', table), new Date('2026-11-25T12:00:00Z'))).toBe(5)
    expect(daysLeft(windowCloses(visit, 'IN', table), new Date('2026-11-25T12:00:00Z'))).toBe(-25)
  })
  it('turns red at 7 days or less, amber at 21', () => {
    expect(windowTone(7)).toBe('danger')
    expect(windowTone(0)).toBe('danger')
    expect(windowTone(-3)).toBe('danger')
    expect(windowTone(8)).toBe('warn')
    expect(windowTone(21)).toBe('warn')
    expect(windowTone(22)).toBe('none')
    expect(windowLabel(3)).toBe('3d left')
    expect(windowLabel(0)).toBe('closes today')
    expect(windowLabel(-2)).toBe('closed 2d ago')
  })
})
