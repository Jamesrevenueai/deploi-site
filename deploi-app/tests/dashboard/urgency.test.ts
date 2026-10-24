import './env'
import { describe, it, expect } from 'vitest'
import { URGENCY_RULES, levelFor, matchRule, rankActionItems, LEVEL_ORDER, type ActionItem } from '../../lib/dashboard/urgency'

const item = (kind: ActionItem['kind'], signal: Partial<ActionItem['signal']>, title: string = kind): ActionItem => ({ kind, title, detail: '', href: null, signal: { kind, ...signal } })

describe('urgency rules', () => {
  it('are ordered from most to least urgent and every rule has a threshold description', () => {
    let last = 0
    for (const r of URGENCY_RULES) { expect(LEVEL_ORDER[r.level]).toBeGreaterThanOrEqual(last); last = LEVEL_ORDER[r.level]; expect(r.description.length).toBeGreaterThan(10) }
    expect(new Set(URGENCY_RULES.map(r => r.id)).size).toBe(URGENCY_RULES.length)
  })

  it('first matching rule wins, thresholds inclusive', () => {
    expect(matchRule({ kind: 'exception', daysLeft: 2 })?.id).toBe('exception_window_2d')
    expect(matchRule({ kind: 'exception', daysLeft: 3 })?.id).toBe('exception_window_7d')
    expect(matchRule({ kind: 'exception', daysLeft: 7 })?.level).toBe('high')
    expect(matchRule({ kind: 'exception', daysLeft: 8 })?.id).toBe('exception_open')
    expect(levelFor({ kind: 'shift', hoursUntil: 11 })).toBe('urgent')
    expect(levelFor({ kind: 'shift', hoursUntil: 30 })).toBe('high')
    expect(levelFor({ kind: 'shift', hoursUntil: 90 })).toBe('medium')
    expect(levelFor({ kind: 'authorization', pctLeft: 5 })).toBe('urgent')
    expect(levelFor({ kind: 'authorization', pctLeft: 15 })).toBe('high')
    expect(levelFor({ kind: 'authorization', pctLeft: 40 })).toBe('low')
    expect(levelFor({ kind: 'referral', count: 1 })).toBe('medium')
    expect(levelFor({ kind: 'referral', count: 0 })).toBe('low')
    expect(levelFor({ kind: 'approval', count: 3 })).toBe('medium')
    expect(levelFor({ kind: 'freshness', staleDays: 14 })).toBe('high')
    expect(levelFor({ kind: 'freshness', staleDays: 8 })).toBe('medium')
    expect(levelFor({ kind: 'freshness', staleDays: 2 })).toBe('low')
    expect(levelFor({ kind: 'credential', daysLeft: 7 })).toBe('high')
    expect(levelFor({ kind: 'credential', daysLeft: 20 })).toBe('low')
    expect(levelFor({ kind: 'credential', daysLeft: null })).toBe('low')
  })

  it('ranks by level, then rule order, then tightness, keeping input order for ties', () => {
    const ranked = rankActionItems([
      item('referral', { count: 1 }, 'ref'),
      item('exception', { daysLeft: 9 }, 'ex-9'),
      item('shift', { hoursUntil: 6 }, 'shift-6h'),
      item('exception', { daysLeft: 1 }, 'ex-1'),
      item('authorization', { pctLeft: 12 }, 'auth-12'),
      item('approval', { count: 2 }, 'appr'),
      item('exception', { daysLeft: 0 }, 'ex-0'),
      item('freshness', { staleDays: 20 }, 'stale-20'),
    ])
    expect(ranked.map(r => r.title)).toEqual(['ex-0', 'ex-1', 'shift-6h', 'auth-12', 'stale-20', 'ref', 'appr', 'ex-9'])
    expect(ranked[0]).toMatchObject({ level: 'urgent', rule: 'exception_window_2d' })
    expect(ranked.at(-1)).toMatchObject({ level: 'medium', rule: 'exception_open' })
    expect(Object.keys(ranked[0])).not.toContain('_i')
  })
})
