/** Shared setup for the autonomy, events, loop and undo tests (workstream W1). */
import { admin } from '../../lib/db'
import { setNotifyImpl, type OwnerUpdate } from '../../lib/notify'
import { NW, HB } from '../merchant/helpers'

export const sent: OwnerUpdate[] = []
/** Capture owner updates in memory (the real mailer belongs to another workstream). */
export function captureNotify() {
  sent.length = 0
  setNotifyImpl({ owner: async u => { sent.push(u); return { status: 'sent', id: `n${sent.length}` } } })
}
export function releaseNotify() {
  setNotifyImpl({ owner: async () => ({ status: 'skipped', id: null, reason: 'owner updates not wired yet' }) })
}

export async function cleanW1() {
  await admin(async db => {
    for (const org of [NW.org, HB.org]) {
      await db.query('delete from undo_tokens where org_id = $1', [org])
      await db.query('delete from agent_loops where org_id = $1', [org])
      await db.query('delete from agent_events where org_id = $1', [org])
      await db.query('delete from org_action_modes where org_id = $1', [org])
      await db.query(`delete from cases where org_id = $1 and kind = 'agent_action'`, [org])
      await db.query('delete from org_controls where org_id = $1', [org])
    }
    await db.query(`delete from jobs where kind in ('event.handle', 'loop.resume', 'case.check')`)
    await db.query(`delete from agent_events where source = 'sweep'`)
  })
}
