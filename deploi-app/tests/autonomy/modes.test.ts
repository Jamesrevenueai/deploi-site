/** Autonomy modes: defaults, overrides per organization, money actions, roles and the audit trail. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { modeFor, DEFAULT_MODE, MONEY_ACTIONS, registerActionTypes, knownActionTypes } from '../../lib/autonomy'
import { listModes, setMode } from '../../lib/autonomy/settings'
import { NW, HB, merchantActor, staffActor } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { cleanW1 } from './helpers'

const ready = await prepareDb()

describe('autonomy defaults (no database needed)', () => {
  it('act_and_tell is the default, money actions included; packs add their action types', async () => {
    expect(DEFAULT_MODE).toBe('act_and_tell')
    expect([...MONEY_ACTIONS]).toEqual(['refund', 'discount', 'payout_dispute', 'invoice_send', 'credit_note'])
    registerActionTypes([{ key: 'w1_test_action', label: 'Do a test thing' }])
    const types = await knownActionTypes()
    expect(types.find(t => t.key === 'w1_test_action')).toEqual({ key: 'w1_test_action', label: 'Do a test thing', money: false })
    expect(types.filter(t => t.money).map(t => t.key).sort()).toEqual([...MONEY_ACTIONS].sort())
  })
})

describe.skipIf(!ready)('org_action_modes', () => {
  beforeEach(cleanW1)
  afterAll(async () => { await cleanW1(); await removePeople(NW) })

  it('every action, money ones included, is act_and_tell until the owner changes it; an override applies to that organization only', async () => {
    for (const t of ['send_customer_email', 'refund', 'discount', 'never_heard_of_it', 'Bad Key!']) expect(await admin(db => modeFor(db, NW.org, t))).toBe('act_and_tell')
    const owner = await merchantActor(NW)
    expect(await setMode(owner, 'refund', 'ask_first')).toEqual({ actionType: 'refund', mode: 'ask_first', changed: true })
    expect(await admin(db => modeFor(db, NW.org, 'refund'))).toBe('ask_first')
    expect(await admin(db => modeFor(db, HB.org, 'refund'))).toBe('act_and_tell')
    expect(await admin(db => modeFor(db, NW.org, 'discount'))).toBe('act_and_tell')
    expect(await setMode(owner, 'refund', 'ask_first')).toMatchObject({ changed: false })
    expect(await setMode(owner, 'refund', 'act_and_tell')).toMatchObject({ mode: 'act_and_tell', changed: true })
    expect(await admin(db => modeFor(db, NW.org, 'refund'))).toBe('act_and_tell')
    // modeFor through the organization's own RLS view reads the same setting
    await setMode(owner, 'update_listing', 'ask_first')
    expect(await withUser(SESSIONS.northwind, db => modeFor(db, NW.org, 'update_listing'))).toBe('ask_first')
    // another organization's session sees none of it (falls back to the default)
    expect(await withUser(SESSIONS.harbor, db => modeFor(db, NW.org, 'update_listing'))).toBe('act_and_tell')
  })

  it('only owners and admins change modes; members, viewers and staff are refused; bad input is refused', async () => {
    const adminP = await person(NW, 'admin', 'w1-admin')
    const member = await person(NW, 'member', 'w1-member')
    const viewer = await person(NW, 'viewer', 'w1-viewer')
    expect(await setMode(adminP, 'discount', 'ask_first')).toMatchObject({ mode: 'ask_first' })
    await expect(setMode(member, 'discount', 'act_and_tell')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setMode(viewer, 'discount', 'act_and_tell')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setMode(await staffActor(), 'discount', 'act_and_tell')).rejects.toMatchObject({ code: 'forbidden' })
    const owner = await merchantActor(NW)
    await expect(setMode(owner, 'discount', 'sometimes')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(setMode(owner, 'not_a_known_action', 'ask_first')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(setMode(owner, "x'; drop table jobs; --", 'ask_first')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await admin(db => modeFor(db, NW.org, 'discount'))).toBe('ask_first')
    // the list: money actions grouped on their own, who may change them
    const v = await listModes(member)
    expect(v.canChange).toBe(false)
    expect(v.money.map(m => m.key).sort()).toEqual([...MONEY_ACTIONS].sort())
    expect(v.money.find(m => m.key === 'discount')).toMatchObject({ mode: 'ask_first', custom: true, updatedBy: adminP.label })
    expect(v.actions.every(a => !a.money)).toBe(true)
    expect((await listModes(owner)).canChange).toBe(true)
  })

  it('every change is audited with who, from and to', async () => {
    const owner = await merchantActor(NW)
    await setMode(owner, 'payout_dispute', 'ask_first', { ip: '192.0.2.7' })
    await setMode(owner, 'payout_dispute', 'act_and_tell')
    const rows = await admin(db => db.query<{ actor: string; detail: Record<string, unknown> }>(`select actor, detail from engine_audit where org_id = $1 and event = 'autonomy.mode_changed' and detail->>'action_type' = 'payout_dispute' order by id desc limit 2`, [NW.org]))
    expect(rows.map(r => [r.actor, r.detail.from, r.detail.to])).toEqual([[owner.label, 'ask_first', 'act_and_tell'], [owner.label, 'act_and_tell', 'ask_first']])
    expect(rows[1].detail.ip).toBe('192.0.2.7')
  })
})
