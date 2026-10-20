import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { getConversationGate, listHeld } from '../../lib/sales/conversations'
import { advances } from '../../lib/sales/stages'

// tests/setup.ts forces .env.test; allow a per-section database for parallel section work
if (process.env.SALES_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.SALES_TEST_DATABASE_URL
const ready = await prepareDb()

describe('stage ordering', () => {
  it('advances only forward; lost is terminal', () => {
    expect(advances('new', 'contacted')).toBe(true)
    expect(advances('call_booked', 'replied')).toBe(false)
    expect(advances('lost', 'replied')).toBe(false)
    expect(advances('replied', 'lost')).toBe(true)
  })
})

describe.skipIf(!ready)('conversation gate against the seed', () => {
  const p4 = uuidFrom('prospect:p4') // Capital City Caregivers, call_booked in the seed
  const resetP4 = () => admin(async db => {
    await db.query("delete from touches where prospect_id = $1 and body = 'held'", [p4])
    await db.query("update prospects set stage = 'call_booked', biggest_leak = null where id = $1", [p4])
  })
  beforeAll(resetP4)
  it('counts 5 held conversations (3 call_held + assessment_sold + build_sold) with their biggest leaks', async () => {
    const gate = await withUser(SESSIONS.staff, db => getConversationGate(db))
    expect(gate).toEqual({ held: 5, goal: 10, open: false })
    const held = await withUser(SESSIONS.staff, db => listHeld(db))
    expect(held.map(h => h.agency_name).sort()).toEqual(['Buckeye Home Care', 'Heartland Waiver Services', 'Maple Grove Home Health', 'Northstar Supports', 'Scioto Valley Home Care'])
    expect(held.every(h => h.biggest_leak)).toBe(true)
    console.log(`Conversation gate: ${gate.held} / ${gate.goal}`)
  })

  it('logging a held call moves a call_booked prospect to call_held and counts toward the gate', async () => {
    const id = p4
    try {
      await withUser(SESSIONS.staff, async db => {
        await db.query(`insert into touches (prospect_id, channel, direction, subject, body, meta) values ($1,'call','outbound','Discovery call','held',$2)`, [id, JSON.stringify({ outcome: 'held', biggest_leak: 'test leak' })])
        await db.query(`update prospects set biggest_leak = 'test leak', stage = 'call_held' where id = $1`, [id])
      })
      const gate = await withUser(SESSIONS.staff, db => getConversationGate(db))
      expect(gate.held).toBe(6)
    } finally { await resetP4() }
  })
})
