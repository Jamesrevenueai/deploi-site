/** Switching Deploi Office off stops every Office agent before the product is disabled; only owners and admins may. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { runOfficeAgent } from '../../lib/office/run'
import { runOfficeScheduler } from '../../lib/office/scheduler'
import { getSynthMail } from '../../lib/email/adapters/synthetic'
import { disableOffice } from '../../lib/office/product'
import { hasProduct } from '../../lib/products'
import { NW, HB, setupOffice, grantedAgent, actions, lead, t0, pinClock, resetOffice, type OfficeSetup } from './helpers'

const ready = await prepareDb()
afterAll(async () => { if (ready) { await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })

describe.skipIf(!ready)('switching Deploi Office off', () => {
  let s: OfficeSetup
  const T = t0()
  afterEach(() => { vi.useRealTimers() })
  beforeEach(async () => { pinClock(T); s = await setupOffice(NW, [lead('901', 'kim@north-studio.example', new Date(T.getTime() - 3600e3))]) })

  it('pauses every Office agent, cancels what was waiting, disables the product, and nothing is sent afterwards', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_approved' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    expect((await actions(agent))[0].status).toBe('awaiting_approval')

    const r = await disableOffice(s.actor)
    expect(r).toEqual({ agentsPaused: 1, actionsCancelled: 1 })
    expect((await admin(db => db.one<{ status: string }>('select status from office_agents where id = $1', [agent])))!.status).toBe('paused')
    expect((await actions(agent))[0].status).toBe('cancelled')
    expect(await admin(db => hasProduct(db, NW.org, 'office'))).toBe(false)
    await runOfficeScheduler({ now: new Date(T.getTime() + 3600e3) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
  })

  it('a member cannot switch Office off', async () => {
    const owner = s.actor.kind === 'profile' ? s.actor.session.uid : null
    await admin(db => db.query(`update profiles set org_role = 'member' where id = $1`, [owner]))
    try {
      await expect(disableOffice(s.actor)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await admin(db => hasProduct(db, NW.org, 'office'))).toBe(true)
    } finally { await admin(db => db.query(`update profiles set org_role = 'owner' where id = $1`, [owner])) }
  })
})
